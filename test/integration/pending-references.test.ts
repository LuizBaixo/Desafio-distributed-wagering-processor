import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { ReprocessPendingReferences } from "../../src/application/wagering/reprocess-pending-references";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import { WagerTransactionKind } from "../../src/domain/wagering/enums";
import { PendingReferenceWorker } from "../../src/interfaces/workers/pending-reference.worker";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { startTestApp, type TestApp } from "../helpers/http";
import { postWager } from "../helpers/wager-http";

const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const ROUND = "round-987";

let app: TestApp;

beforeAll(async () => {
  await migrateUp();
  app = await startTestApp();
});

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await assertLedgerConsistent();
});

afterAll(async () => {
  await app.close();
  await closePools();
});

function reprocessor(a: TestApp): ReprocessPendingReferences {
  return (a.app as INestApplication).get(ReprocessPendingReferences);
}

async function createWallet(amount: string): Promise<string> {
  const res = await fetch(`${app.baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: PLAYER, initialBalance: { amount, currency: "BRL" } }),
  });
  return ((await res.json()) as { id: string }).id;
}

function cmd(walletId: string, over: Partial<WagerCommand> & { externalTransactionId: string }): WagerCommand {
  return {
    providerId: "provider-a",
    idempotencyKey: `provider-a:${over.externalTransactionId}`,
    playerId: PLAYER,
    walletId,
    roundId: ROUND,
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    ...over,
  };
}

async function balanceOf(walletId: string): Promise<string> {
  const res = await fetch(`${app.baseUrl}/wallets/${walletId}`);
  return ((await res.json()) as { balance: { amount: string } }).balance.amount;
}

async function statusOf(externalId: string): Promise<{ status: string; failure_code: string | null }> {
  const { rows } = await ownerPool().query<{ status: string; failure_code: string | null }>(
    `SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = $1`,
    [externalId],
  );
  return rows[0]!;
}

describe("worker de referências pendentes", () => {
  test("C7a: ROLLBACK antes da BET fica pendente; depois da BET e de um tick, as duas PROCESSED e saldo inicial", async () => {
    const walletId = await createWallet("1000.00");
    const rb = await postWager(
      app.baseUrl,
      cmd(walletId, { externalTransactionId: "rb-1", kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "bet-1" }),
    );
    expect(rb.status).toBe(202);
    expect(rb.body.status).toBe("PENDING_REFERENCE");

    const bet = await postWager(app.baseUrl, cmd(walletId, { externalTransactionId: "bet-1" }));
    expect(bet.status).toBe(200);

    await reprocessor(app).tick();

    expect((await statusOf("rb-1")).status).toBe("PROCESSED");
    expect((await statusOf("bet-1")).status).toBe("PROCESSED");
    expect(await balanceOf(walletId)).toBe("1000.00");
  });

  test("C7b: cadeia REFUND -> ROLLBACK do REFUND chega antes da BET; após a BET e até 3 ticks, tudo PROCESSED e saldo = inicial - BET", async () => {
    const walletId = await createWallet("1000.00");
    const refund = await postWager(
      app.baseUrl,
      cmd(walletId, { externalTransactionId: "refund-1", kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-1" }),
    );
    expect(refund.status).toBe(202);
    const rb = await postWager(
      app.baseUrl,
      cmd(walletId, {
        externalTransactionId: "rb-2",
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: "refund-1",
      }),
    );
    expect(rb.status).toBe(202);

    expect((await postWager(app.baseUrl, cmd(walletId, { externalTransactionId: "bet-1" }))).status).toBe(200);

    for (let i = 0; i < 3; i++) await reprocessor(app).tick();

    expect((await statusOf("refund-1")).status).toBe("PROCESSED");
    expect((await statusOf("rb-2")).status).toBe("PROCESSED");
    expect(await balanceOf(walletId)).toBe("975.00");
  });

  test("replay do request original de um pendente, antes de resolver: 202 com idempotentReplay true", async () => {
    const walletId = await createWallet("1000.00");
    const original = cmd(walletId, {
      externalTransactionId: "refund-replay",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet-missing",
    });
    expect((await postWager(app.baseUrl, original)).status).toBe(202);

    const replay = await postWager(app.baseUrl, original);
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.status).toBe("PENDING_REFERENCE");
  });

  test("50 pendentes destravadas e dois ticks em paralelo: cada WIN aplicada uma única vez", async () => {
    const walletId = await createWallet("100.00");
    for (let i = 0; i < 50; i++) {
      const res = await postWager(
        app.baseUrl,
        cmd(walletId, {
          externalTransactionId: `win-${i}`,
          kind: WagerTransactionKind.Win,
          money: { amount: "1.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-par",
        }),
      );
      expect(res.status).toBe(202);
    }
    expect((await postWager(app.baseUrl, cmd(walletId, { externalTransactionId: "bet-par" }))).status).toBe(200);

    const worker = reprocessor(app);
    let claimed = 1;
    while (claimed > 0) {
      const [a, b] = await Promise.all([worker.tick(), worker.tick()]);
      claimed = a + b;
    }

    const { rows } = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries l
         JOIN wager_transactions t ON t.id = l.transaction_id
        WHERE t.kind = 'WIN' AND l.direction = 'CREDIT' AND t.status = 'PROCESSED'`,
    );
    expect(rows[0]!.n).toBe(50);
    expect(await balanceOf(walletId)).toBe("125.00");
  });

  test("worker não liga sozinho nos testes (papel api): isRunning false", () => {
    expect((app.app as INestApplication).get(PendingReferenceWorker).isRunning()).toBe(false);
  });
});

describe("limite de tentativas", () => {
  let limited: TestApp;

  beforeAll(async () => {
    limited = await startTestApp({ PENDING_MAX_ATTEMPTS: "3" });
  });

  afterAll(async () => {
    await limited.close();
  });

  test("referência que nunca chega: após 4 ticks, REJECTED REFERENCE_NOT_FOUND e WagerTransactionRejected na outbox", async () => {
    const res = await fetch(`${limited.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: PLAYER, initialBalance: { amount: "1000.00", currency: "BRL" } }),
    });
    const walletId = ((await res.json()) as { id: string }).id;
    const pending = await postWager(
      limited.baseUrl,
      cmd(walletId, {
        externalTransactionId: "refund-never",
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "bet-never",
      }),
    );
    expect(pending.status).toBe(202);

    const worker = reprocessor(limited);
    for (let i = 0; i < 4; i++) {
      // Força o backoff a zero: próximo tick pega a linha de novo.
      await ownerPool().query(
        `UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second'
          WHERE external_transaction_id = 'refund-never'`,
      );
      await worker.tick();
    }

    const tx = await statusOf("refund-never");
    expect(tx.status).toBe("REJECTED");
    expect(tx.failure_code).toBe("REFERENCE_NOT_FOUND");
    expect(await balanceOf(walletId)).toBe("1000.00");

    const { rows } = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_messages o
         JOIN wager_transactions t ON t.id::text = o.payload->'data'->>'transactionId'
        WHERE o.event_type = 'WagerTransactionRejected' AND t.external_transaction_id = 'refund-never'`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe("papel pending", () => {
  test("liga o loop, processa sozinho e para no shutdown", async () => {
    const on = await startTestApp({ APP_ROLES: "api,pending", PENDING_POLL_MS: "50" });
    const worker = (on.app as INestApplication).get(PendingReferenceWorker);
    try {
      expect(worker.isRunning()).toBe(true);

      const wres = await fetch(`${on.baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: PLAYER, initialBalance: { amount: "1000.00", currency: "BRL" } }),
      });
      const walletId = ((await wres.json()) as { id: string }).id;
      await postWager(
        on.baseUrl,
        cmd(walletId, {
          externalTransactionId: "refund-loop",
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: "bet-loop",
        }),
      );
      await postWager(on.baseUrl, cmd(walletId, { externalTransactionId: "bet-loop" }));

      let status = "";
      for (let i = 0; i < 60 && status !== "PROCESSED"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = (await statusOf("refund-loop")).status;
      }
      expect(status).toBe("PROCESSED");
    } finally {
      await on.close();
    }
    expect(worker.isRunning()).toBe(false);
  });
});
