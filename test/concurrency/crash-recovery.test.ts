import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/enums";
import { spawnApp, type AppProcess } from "../helpers/app-process";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect, type DirectWallet } from "../helpers/factories";
import { EVENTS_QUEUE, WAGER_DLQ, WAGER_QUEUE, purgeAll, queueDepth, receiveAll, sendWager, waitFor } from "../helpers/sqs";
import { buildWagerHarness } from "../helpers/wager-harness";
import { postWager } from "../helpers/wager-http";

/** Portas desta suíte ficam acima das de multi-instance (BASE..BASE+2). */
const BASE_PORT = Number(process.env.TEST_PORT_BASE ?? 4101) + 20;

let spawned: AppProcess[] = [];
async function start(port: number, roles: string, env: Record<string, string> = {}): Promise<AppProcess> {
  const app = await spawnApp({ port, roles, env: { NODE_ENV: "test", CONSUMER_WAIT_SECONDS: "1", ...env } });
  spawned.push(app);
  return app;
}

beforeAll(async () => {
  await migrateUp();
});
beforeEach(async () => {
  await resetDb();
  await purgeAll();
});
afterEach(async () => {
  await Promise.all(spawned.map((a) => a.kill("SIGKILL").catch(() => undefined)));
  spawned = [];
  await assertLedgerConsistent();
});
afterAll(async () => {
  await closePools();
});

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ v: string }>(sql, params);
  return r.rows[0]!.v;
}

// ------------------------------------------------------------------------------------------ C5

describe("C5: crash between commit and ack", () => {
  test("process dies after the commit (137); a new process redelivers, the inbox deduplicates, one debit, queue empty", async () => {
    const w = await createWalletDirect("1000.00");
    const crashing = await start(BASE_PORT, "consumer", {
      FAULT_INJECT: "exit_after_commit",
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "3",
    });
    const cmd = buildWagerCommand({
      walletId: w.walletId,
      playerId: w.playerId,
      money: { amount: "10.00", currency: "BRL" },
    });
    await sendWager(cmd);

    expect(await crashing.waitExit()).toBe(137);
    expect(await scalar(`SELECT status AS v FROM wager_transactions WHERE external_transaction_id = $1`, [cmd.externalTransactionId])).toBe("PROCESSED");
    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toBe("1");
    expect(await queueDepth(WAGER_QUEUE)).toBe(1); // sem ack

    // Processo novo, sem falha injetada. A mensagem volta quando o visibility timeout vence.
    const fresh = await start(BASE_PORT + 1, "consumer", { CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "3" });
    await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 0, { timeoutMs: 20_000, what: "redelivered message acknowledged" });

    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toBe("1");
    expect(await scalar(`SELECT count(*)::text AS v FROM inbox_messages`)).toBe("1");
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [w.walletId])).toBe("990.00");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);

    const metrics = await (await fetch(`${fresh.baseUrl}/metrics`)).text();
    const inboxDuplicates = Number(/duplicates_detected_total\{source="inbox",result="message"\} (\d+)/.exec(metrics)?.[1] ?? 0);
    if (inboxDuplicates < 1) {
      const lines = metrics.split("\n").filter((l) => l.startsWith("duplicates") || l.startsWith("wager_"));
      console.error(`C5 /metrics of the new process:\n${lines.join("\n")}`);
    }
    expect(inboxDuplicates).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

// ------------------------------------------------------------------------------------------ C6

describe("C6: two outbox publishers", () => {
  test("300 events from 150 BETs, 2 publisher processes: each eventId published once, 300 distinct messages in wallet-events.fifo", async () => {
    // 5 wallets x 30 BET 1.00 pelo caso de uso, sem nenhum publisher no ar: a outbox acumula 300 eventos.
    const h = await buildWagerHarness();
    const wallets: DirectWallet[] = [];
    try {
      for (let i = 0; i < 5; i++) wallets.push(await createWalletDirect("1000.00"));
      await Promise.all(
        wallets.flatMap((w) =>
          Array.from({ length: 30 }, () =>
            h.submit.execute(
              buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: { amount: "1.00", currency: "BRL" } }),
              { correlationId: "c6" },
            ),
          ),
        ),
      );
    } finally {
      await h.close();
    }
    expect(await scalar(`SELECT count(*)::text AS v FROM outbox_messages`)).toBe("300");
    expect(await scalar(`SELECT count(*)::text AS v FROM outbox_messages WHERE published_at IS NULL`)).toBe("300");
    await receiveAll(EVENTS_QUEUE, 0); // descarta eventos de outros testes que ainda estejam na fila

    await Promise.all([start(BASE_PORT + 2, "outbox"), start(BASE_PORT + 3, "outbox")]);
    await waitFor(
      async () => (await scalar(`SELECT count(*)::text AS v FROM outbox_messages WHERE published_at IS NULL`)) === "0",
      { timeoutMs: 60_000, what: "outbox drained" },
    );

    // Cada evento tem published_at e a fila não tem repetição por eventId.
    expect(await scalar(`SELECT count(*)::text AS v FROM outbox_messages WHERE published_at IS NOT NULL`)).toBe("300");
    const mine = new Set(wallets.map((w) => w.walletId));
    const received: string[] = [];
    await waitFor(
      async () => {
        for (const m of await receiveAll(EVENTS_QUEUE, 1)) {
          const ev = JSON.parse(m.body) as { eventId: string; aggregateId: string };
          if (mine.has(ev.aggregateId)) received.push(ev.eventId);
        }
        return new Set(received).size >= 300;
      },
      { timeoutMs: 30_000, what: `300 distinct events in wallet-events.fifo (got ${new Set(received).size} distinct, ${received.length} total)` },
    );
    expect(new Set(received).size).toBe(300);
    expect(received).toHaveLength(300); // o FIFO deduplica por MessageDeduplicationId = eventId
  }, 120_000);
});

// ------------------------------------------------------------------------------------------ C8

interface Op {
  cmd: WagerCommand;
  channel: "http" | "sqs";
  /** Mesma messageId reenviada com dedup id diferente (duplicata da entrega). */
  messageId?: string;
  dedupSuffix?: string;
}

const C8_PORTS = BASE_PORT + 10;
const CONVERGENCE_MS = 60_000;

describe("C8: mixed load, one instance killed mid-run", () => {
  test("3 instances (api,consumer,outbox,pending), 200 operations over 5 wallets, SIGKILL of one instance, restart: converges consistent", async () => {
    const env = { CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "5", CONSUMER_MAX_BACKOFF_SECONDS: "2" };
    const roles = "api,consumer,outbox,pending";
    const instances: AppProcess[] = await Promise.all([0, 1, 2].map((i) => start(C8_PORTS + i, roles, env)));
    let nextPort = C8_PORTS + 3;

    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWalletDirect("1000.00")));
    const { ops, unique } = buildMixedOps(wallets);
    expect(ops).toHaveLength(200);

    // Despacho com concorrência limitada; no op 80 mata a instância 0 (SIGKILL) e sobe outra.
    const deadPids = new Set<number>();
    const live = () => instances.filter((a) => !deadPids.has(a.pid));
    let dispatched = 0;
    let killed = false;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ops.length) {
        const op = ops[cursor++]!;
        if (!killed && dispatched >= 80) {
          killed = true;
          const victim = instances[0]!;
          deadPids.add(victim.pid);
          await victim.kill("SIGKILL");
          instances.push(await start(nextPort++, roles, env));
        }
        dispatched++;
        await dispatch(op, live, dispatched);
        await Bun.sleep(5);
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    expect(killed).toBe(true);

    await converge();

    // Cada operação única existe exatamente uma vez e todas terminaram PROCESSED.
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE kind <> 'OPENING'`)).toBe(String(unique.total));
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE kind <> 'OPENING' AND status <> 'PROCESSED'`)).toBe("0");
    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE direction = 'DEBIT'`)).toBe(String(unique.bet));
    expect(
      await scalar(
        `SELECT count(*)::text AS v FROM wallet_ledger_entries
          WHERE direction = 'CREDIT' AND transaction_id IN (SELECT id FROM wager_transactions WHERE kind <> 'OPENING')`,
      ),
    ).toBe(String(unique.win + unique.refund));
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);

    await assertLedgerConsistent();
    const alive = live()[0]!;
    for (const w of wallets) {
      const res = await fetch(`${alive.baseUrl}/wallets/${w.walletId}/reconciliation`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { consistent: boolean }).consistent).toBe(true);
    }
  }, 180_000);
});

/**
 * 5 wallets x 32 operações únicas (20 BET, 5 REFUND e 4 WIN antes das BETs que referenciam, 3 LOSS)
 * mais 8 duplicatas por wallet (4 replays HTTP, 2 SQS com a mesma messageId, 2 SQS com messageId nova): 200.
 */
function buildMixedOps(wallets: DirectWallet[]): {
  ops: Op[];
  unique: { total: number; bet: number; win: number; refund: number };
} {
  const money = (amount: string) => ({ amount, currency: "BRL" });
  const unique = { total: 0, bet: 0, win: 0, refund: 0 };
  const perWallet: Op[][] = [];

  for (const w of wallets) {
    const base = { walletId: w.walletId, playerId: w.playerId };
    const bets = Array.from({ length: 20 }, () => buildWagerCommand({ ...base, money: money("5.00") }));
    const refunds = bets
      .slice(0, 5)
      .map((b) => buildWagerCommand({ ...base, kind: Kind.Refund, money: money("5.00"), referenceExternalTransactionId: b.externalTransactionId }));
    const wins = bets
      .slice(10, 14)
      .map((b) => buildWagerCommand({ ...base, kind: Kind.Win, money: money("10.00"), referenceExternalTransactionId: b.externalTransactionId }));
    const losses = Array.from({ length: 3 }, () => buildWagerCommand({ ...base, kind: Kind.Loss, money: money("5.00") }));

    const ordered: WagerCommand[] = [...refunds, ...wins, ...bets, ...losses];
    unique.total += ordered.length;
    unique.bet += bets.length;
    unique.win += wins.length;
    unique.refund += refunds.length;

    const own: Op[] = ordered.map((cmd, i) => ({ cmd, channel: i % 2 === 0 ? "http" : "sqs" }));
    const dups: Op[] = [];
    const pick = (n: number) => own[(n * 7) % own.length]!.cmd;
    for (let d = 0; d < 4; d++) dups.push({ cmd: pick(d), channel: "http" });
    // Mesma messageId: a original (índice ímpar, canal SQS) ganha um id fixo e é reenviada com outro dedup id.
    for (const i of [1, 3]) {
      const original = own[i]!;
      original.messageId = `fixed-${original.cmd.idempotencyKey}`;
      dups.push({ cmd: original.cmd, channel: "sqs", messageId: original.messageId, dedupSuffix: "b" });
    }
    // messageId nova com a mesma idempotencyKey.
    for (let d = 6; d < 8; d++) dups.push({ cmd: pick(d), channel: "sqs" });
    // 32 únicas + 8 duplicatas; as duplicatas entram depois das primeiras 20 operações da wallet.
    perWallet.push([...own.slice(0, 20), ...dups, ...own.slice(20)]);
  }

  // Intercala as wallets, preservando a ordem relativa dentro de cada uma.
  const ops: Op[] = [];
  while (perWallet.some((q) => q.length > 0)) for (const q of perWallet) if (q.length > 0) ops.push(q.shift()!);
  return { ops, unique };
}

async function dispatch(op: Op, live: () => AppProcess[], n: number): Promise<void> {
  if (op.channel === "sqs") {
    const messageId = op.messageId ?? crypto.randomUUID();
    await sendWager(op.cmd, messageId, `${messageId}-${op.dedupSuffix ?? "x"}-${n}`);
    return;
  }
  // HTTP: se a instância morreu ou respondeu 5xx, reenvia (mesma Idempotency-Key) para outra.
  let lastError = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const pool = live();
    const target = pool[(n + attempt) % pool.length]!;
    try {
      const res = await postWager(target.baseUrl, op.cmd);
      if (res.status < 500) return;
      lastError = `status ${res.status}`;
    } catch (e) {
      lastError = String(e);
    }
    await Bun.sleep(100);
  }
  throw new Error(`HTTP dispatch failed after retries: ${lastError}`);
}

async function snapshot(): Promise<Record<string, unknown>> {
  const q = async (sql: string) => (await ownerPool().query(sql)).rows;
  return {
    mainQueueDepth: await queueDepth(WAGER_QUEUE),
    dlqDepth: await queueDepth(WAGER_DLQ),
    outboxPending: await q(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`),
    pendingDue: await q(`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()`),
    pendingAll: await q(`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`),
    transactionsByStatus: await q(`SELECT status, count(*)::int AS n FROM wager_transactions GROUP BY status ORDER BY status`),
    inboxRows: await q(`SELECT count(*)::int AS n FROM inbox_messages`),
  };
}

/** Espera fila principal vazia, outbox zerada e nenhum pendente por até 60 s; senão falha imprimindo o estado. */
async function converge(): Promise<void> {
  const deadline = Date.now() + CONVERGENCE_MS;
  for (;;) {
    const s = await snapshot();
    const outbox = (s.outboxPending as { n: number }[])[0]!.n;
    const pending = (s.pendingAll as { n: number }[])[0]!.n;
    if (s.mainQueueDepth === 0 && outbox === 0 && pending === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`C8 did not converge in ${CONVERGENCE_MS}ms:\n${JSON.stringify(s, null, 2)}`);
    }
    await Bun.sleep(500);
  }
}
