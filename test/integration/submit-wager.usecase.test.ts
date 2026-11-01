import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import type { SubmitResult } from "../../src/application/wagering/submit-wager-transaction";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/enums";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect, type DirectWallet } from "../helpers/factories";
import { buildWagerHarness, type WagerHarness } from "../helpers/wager-harness";

let h: WagerHarness;
const ctx = () => ({ correlationId: "corr-test" });

beforeAll(async () => {
  await migrateUp();
  h = await buildWagerHarness();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await h.close();
  await closePools();
});

const cmd = (w: DirectWallet, o: Partial<WagerCommand> = {}) =>
  buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, ...o });

async function count(table: string, where = "true"): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`);
  return Number(r.rows[0]!.n);
}

async function eventTypes(): Promise<string[]> {
  const r = await ownerPool().query<{ event_type: string }>(
    `SELECT event_type FROM outbox_messages ORDER BY occurred_at, event_type`,
  );
  return r.rows.map((x) => x.event_type);
}

function view(r: SubmitResult) {
  if (r.kind === "duplicateMessage" || r.kind === "conflict") throw new Error(`unexpected ${r.kind}`);
  return r.view;
}

describe("SubmitWagerTransaction: basics", () => {
  test("BET 25.00 is PROCESSED with balance 975.00 and writes tx, ledger, wallet and 2 events together", async () => {
    const w = await createWalletDirect("1000.00");
    const r = await h.submit.execute(cmd(w), ctx());
    expect(r.kind).toBe("processed");
    expect(view(r)).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      failureCode: null,
      idempotentReplay: false,
    });
    expect(await count("wager_transactions", "kind = 'BET'")).toBe(1);
    expect(await count("wallet_ledger_entries", "direction = 'DEBIT'")).toBe(1);
    expect(await eventTypes()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    const wallet = await ownerPool().query(`SELECT balance::text AS b, version FROM wallets WHERE id = $1`, [w.walletId]);
    expect(wallet.rows[0]).toEqual({ b: "975.00", version: 2 });
    await assertLedgerConsistent();
  });

  test("replay returns the stored snapshot even after another BET changed the balance", async () => {
    const w = await createWalletDirect("1000.00");
    const first = cmd(w);
    await h.submit.execute(first, ctx());
    await h.submit.execute(cmd(w, { money: { amount: "100.00", currency: "BRL" } }), ctx());

    const before = { tx: await count("wager_transactions"), events: await count("outbox_messages"), ledger: await count("wallet_ledger_entries") };
    const replay = await h.submit.execute(first, ctx());
    expect(view(replay)).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00" }, idempotentReplay: true });
    expect({ tx: await count("wager_transactions"), events: await count("outbox_messages"), ledger: await count("wallet_ledger_entries") }).toEqual(before);
    await assertLedgerConsistent();
  });

  test("same key with another amount is IDEMPOTENCY_CONFLICT: no row, no balance change, Rejected event without transactionId", async () => {
    const w = await createWalletDirect("1000.00");
    const first = cmd(w);
    await h.submit.execute(first, ctx());
    const events = await count("outbox_messages");

    const r = await h.submit.execute({ ...first, money: { amount: "26.00", currency: "BRL" } }, ctx());
    expect(r).toEqual({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
    expect(await count("wager_transactions", "kind = 'BET'")).toBe(1);
    expect(await count("outbox_messages")).toBe(events + 1);
    const ev = await ownerPool().query(
      `SELECT aggregate_id, payload FROM outbox_messages WHERE event_type = 'WagerTransactionRejected'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].aggregate_id).toBe(w.walletId);
    expect(ev.rows[0].payload.data.failureCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(ev.rows[0].payload.data.transactionId).toBeUndefined();
    await assertLedgerConsistent();
  });

  test("new key with the same externalTransactionId is EXTERNAL_ID_CONFLICT with a Rejected event", async () => {
    const w = await createWalletDirect("1000.00");
    const first = cmd(w);
    await h.submit.execute(first, ctx());
    const r = await h.submit.execute({ ...first, idempotencyKey: "another-key" }, ctx());
    expect(r).toEqual({ kind: "conflict", code: "EXTERNAL_ID_CONFLICT" });
    expect(await count("wager_transactions", "kind = 'BET'")).toBe(1);
    const ev = await ownerPool().query(`SELECT payload FROM outbox_messages WHERE event_type = 'WagerTransactionRejected'`);
    expect(ev.rows[0].payload.data.failureCode).toBe("EXTERNAL_ID_CONFLICT");
  });

  test("insufficient funds is a stored REJECTED with balance snapshot; replay returns the same rejection", async () => {
    const w = await createWalletDirect("1000.00");
    const big = cmd(w, { money: { amount: "2000.00", currency: "BRL" } });
    const r = await h.submit.execute(big, ctx());
    expect(r.kind).toBe("rejected");
    expect(view(r)).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "1000.00" } });
    expect(await count("wallet_ledger_entries", "direction = 'DEBIT'")).toBe(0);
    expect(await eventTypes()).toEqual(["WagerTransactionRejected"]);

    // Outra aposta muda o saldo; o replay da rejeição mantém o snapshot de 1000.00.
    await h.submit.execute(cmd(w), ctx());
    const replay = await h.submit.execute(big, ctx());
    expect(replay.kind).toBe("rejected");
    expect(view(replay)).toMatchObject({ failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "1000.00" }, idempotentReplay: true });
    await assertLedgerConsistent();
  });

  test("unknown wallet: WALLET_NOT_FOUND, no wager_transactions row, one Rejected event keyed by the wallet id", async () => {
    const c = buildWagerCommand();
    const r = await h.submit.execute(c, ctx());
    expect(r.kind).toBe("rejected");
    expect(view(r)).toMatchObject({ transactionId: null, status: "REJECTED", failureCode: "WALLET_NOT_FOUND", balance: null });
    expect(await count("wager_transactions")).toBe(0);
    const ev = await ownerPool().query(`SELECT aggregate_id, payload FROM outbox_messages`);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].aggregate_id).toBe(c.walletId);
    expect(ev.rows[0].payload.eventType).toBe("WagerTransactionRejected");
  });

  test("USD bet on a BRL wallet is CURRENCY_MISMATCH", async () => {
    const w = await createWalletDirect("1000.00");
    const r = await h.submit.execute(cmd(w, { money: { amount: "1.00", currency: "USD" } }), ctx());
    expect(view(r)).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH" });
  });

  test("another player on the wallet is WALLET_PLAYER_MISMATCH", async () => {
    const w = await createWalletDirect("1000.00");
    const r = await h.submit.execute(cmd(w, { playerId: crypto.randomUUID() }), ctx());
    expect(view(r)).toMatchObject({ status: "REJECTED", failureCode: "WALLET_PLAYER_MISMATCH" });
  });

  test("LOSS is PROCESSED without ledger entry or version change, and emits only Processed", async () => {
    const w = await createWalletDirect("1000.00");
    const r = await h.submit.execute(cmd(w, { kind: Kind.Loss }), ctx());
    expect(view(r)).toMatchObject({ status: "PROCESSED", balance: { amount: "1000.00" } });
    expect(await count("wallet_ledger_entries")).toBe(1); // só a OPENING
    const wallet = await ownerPool().query(`SELECT version FROM wallets WHERE id = $1`, [w.walletId]);
    expect(wallet.rows[0].version).toBe(1);
    expect(await eventTypes()).toEqual(["WagerTransactionProcessed"]);
    await assertLedgerConsistent();
  });
});

describe("SubmitWagerTransaction: pending references", () => {
  test("REFUND before its BET is PENDING_REFERENCE; when the BET lands, the pending is made due; ledger stays consistent", async () => {
    const w = await createWalletDirect("1000.00");
    const bet = cmd(w, { externalTransactionId: "bet-ext-1" });
    const refund = cmd(w, { kind: Kind.Refund, referenceExternalTransactionId: "bet-ext-1" });

    const pending = await h.submit.execute(refund, ctx());
    expect(pending.kind).toBe("pending");
    expect(view(pending)).toMatchObject({ status: "PENDING_REFERENCE", balance: null });
    expect(await eventTypes()).toEqual(["WagerTransactionPendingReference"]);

    const row = await ownerPool().query(`SELECT next_attempt_at > now() AS future FROM wager_transactions WHERE kind = 'REFUND'`);
    expect(row.rows[0].future).toBe(true);

    await h.submit.execute(bet, ctx());
    const due = await ownerPool().query(`SELECT next_attempt_at <= now() AS due, status FROM wager_transactions WHERE kind = 'REFUND'`);
    expect(due.rows[0]).toEqual({ due: true, status: "PENDING_REFERENCE" });

    // Replay do pendente: mesmo estado, sem reprocessar.
    const replay = await h.submit.execute(refund, ctx());
    expect(view(replay)).toMatchObject({ status: "PENDING_REFERENCE", idempotentReplay: true });
    await assertLedgerConsistent();
  });

  test("a LOSS (noop) with a pending dependent also makes the dependent due", async () => {
    const w = await createWalletDirect("1000.00");
    // ROLLBACK referencia uma BET que ainda não existe; a BET aqui é apenas um LOSS não, então
    // usamos WIN com referência a um LOSS para exercitar o noop como alvo de um pendente.
    const dependent = cmd(w, { kind: Kind.Win, referenceExternalTransactionId: "loss-ext-1" });
    const pending = await h.submit.execute(dependent, ctx());
    expect(pending.kind).toBe("pending");

    await h.submit.execute(cmd(w, { kind: Kind.Loss, externalTransactionId: "loss-ext-1" }), ctx());
    const due = await ownerPool().query(`SELECT next_attempt_at <= now() AS due FROM wager_transactions WHERE kind = 'WIN'`);
    expect(due.rows[0].due).toBe(true);
  });
});

describe("SubmitWagerTransaction: concurrency", () => {
  test("two parallel BETs of 80.00 on 100.00: one PROCESSED, one INSUFFICIENT_FUNDS, balance 20.00", async () => {
    const w = await createWalletDirect("100.00");
    const results = await Promise.all([
      h.submit.execute(cmd(w, { money: { amount: "80.00", currency: "BRL" } }), ctx()),
      h.submit.execute(cmd(w, { money: { amount: "80.00", currency: "BRL" } }), ctx()),
    ]);
    const statuses = results.map((r) => view(r).status as string).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const wallet = await ownerPool().query(`SELECT balance::text AS b FROM wallets WHERE id = $1`, [w.walletId]);
    expect(wallet.rows[0].b).toBe("20.00");
    expect(await count("wallet_ledger_entries", "direction = 'DEBIT'")).toBe(1);
    await assertLedgerConsistent();
  });

  test("the same request sent 10 times in parallel produces one transaction and nine replays", async () => {
    const w = await createWalletDirect("1000.00");
    const c = cmd(w);
    const results = await Promise.all(Array.from({ length: 10 }, () => h.submit.execute(c, ctx())));
    expect(results.filter((r) => view(r).idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => view(r).idempotentReplay === true)).toHaveLength(9);
    expect(new Set(results.map((r) => view(r).transactionId)).size).toBe(1);
    expect(await count("wager_transactions", "kind = 'BET'")).toBe(1);
    await assertLedgerConsistent();
  });

  test("same key on two different wallets races on the UNIQUE index: one wins, the other retries into IDEMPOTENCY_CONFLICT", async () => {
    const w1 = await createWalletDirect("1000.00");
    const w2 = await createWalletDirect("1000.00");
    const key = `shared-key-${crypto.randomUUID()}`;
    const results = await Promise.all([
      h.submit.execute(cmd(w1, { idempotencyKey: key }), ctx()),
      h.submit.execute(cmd(w2, { idempotencyKey: key }), ctx()),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "processed"]);
    expect(await count("wager_transactions", "kind = 'BET'")).toBe(1);
    await assertLedgerConsistent();
  });
});

describe("SubmitWagerTransaction: retry bound", () => {
  /** UoW que falha com 23505 de idempotência N vezes antes de delegar; conta as chamadas. */
  function flaky(failures: number) {
    let calls = 0;
    const wrap = (inner: UnitOfWork): UnitOfWork => ({
      run: (work) => {
        calls++;
        if (calls <= failures) {
          return Promise.reject(
            Object.assign(new Error("duplicate key"), { code: "23505", constraint: "wager_tx_provider_idempotency_uq" }),
          );
        }
        return inner.run(work);
      },
    });
    return { wrap, calls: () => calls };
  }

  test("a single 23505 is retried once and then succeeds", async () => {
    const f = flaky(1);
    const local = await buildWagerHarness(f.wrap);
    try {
      const w = await createWalletDirect("1000.00");
      const r = await local.submit.execute(cmd(w), ctx());
      expect(r.kind).toBe("processed");
      expect(f.calls()).toBe(2);
    } finally {
      await local.close();
    }
  });

  test("two consecutive 23505 give up after 2 attempts and rethrow", async () => {
    const f = flaky(5);
    const local = await buildWagerHarness(f.wrap);
    try {
      const w = await createWalletDirect("1000.00");
      await expect(local.submit.execute(cmd(w), ctx())).rejects.toMatchObject({ code: "23505" });
      expect(f.calls()).toBe(2);
    } finally {
      await local.close();
    }
  });

  test("a 23505 on another constraint is not retried", async () => {
    let calls = 0;
    const local = await buildWagerHarness(() => ({
      run: () => {
        calls++;
        return Promise.reject(Object.assign(new Error("dup"), { code: "23505", constraint: "wager_tx_one_reversal_per_reference" }));
      },
    }));
    try {
      const w = await createWalletDirect("1000.00");
      await expect(local.submit.execute(cmd(w), ctx())).rejects.toMatchObject({ code: "23505" });
      expect(calls).toBe(1);
    } finally {
      await local.close();
    }
  });
});

describe("SubmitWagerTransaction: inbox", () => {
  const inbox = (messageId: string) => ({ consumerName: "wager-transactions-consumer", messageId, payloadHash: "d".repeat(64) });

  test("a duplicate message is acknowledged without touching anything else", async () => {
    const w = await createWalletDirect("1000.00");
    const c = cmd(w);
    const first = await h.submit.execute(c, { ...ctx(), inbox: inbox("m-1") });
    expect(first.kind).toBe("processed");
    const events = await count("outbox_messages");
    const second = await h.submit.execute(c, { ...ctx(), inbox: inbox("m-1") });
    expect(second).toEqual({ kind: "duplicateMessage" });
    expect(await count("outbox_messages")).toBe(events);
    expect(await count("inbox_messages")).toBe(1);
  });

  test("a different message with the same key is a replay, not a duplicate message", async () => {
    const w = await createWalletDirect("1000.00");
    const c = cmd(w);
    await h.submit.execute(c, { ...ctx(), inbox: inbox("m-1") });
    const second = await h.submit.execute(c, { ...ctx(), inbox: inbox("m-2") });
    expect(view(second)).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
    expect(await count("inbox_messages")).toBe(2);
  });

  test("WALLET_NOT_FOUND keeps the inbox row (audited)", async () => {
    const r = await h.submit.execute(buildWagerCommand(), { ...ctx(), inbox: inbox("m-9") });
    expect(r.kind).toBe("rejected");
    expect(await count("inbox_messages")).toBe(1);
  });

  test("a failure after the inbox insert rolls the inbox back too", async () => {
    const local = await buildWagerHarness((inner) => ({
      run: (work) => inner.run(async (scope) => {
        const out = await work(scope);
        throw new Error("fail before commit");
        return out;
      }),
    }));
    try {
      const w = await createWalletDirect("1000.00");
      await expect(local.submit.execute(cmd(w), { ...ctx(), inbox: inbox("m-rb") })).rejects.toThrow("fail before commit");
      expect(await count("inbox_messages")).toBe(0);
      expect(await count("wager_transactions", "kind = 'BET'")).toBe(0);
      expect(await count("outbox_messages")).toBe(0);
    } finally {
      await local.close();
    }
  });
});

describe("SubmitWagerTransaction: metrics", () => {
  test("transaction, replay and conflict counters", async () => {
    const local = await buildWagerHarness(); // registro de métricas próprio, sem contagem dos outros testes
    const w = await createWalletDirect("1000.00");
    const c = cmd(w);
    await local.submit.execute(c, ctx());
    await local.submit.execute(c, ctx());
    await local.submit.execute({ ...c, money: { amount: "9.00", currency: "BRL" } }, ctx());
    const text = await local.metrics.registry.metrics();
    await local.close();
    expect(text).toMatch(/wager_transactions_total\{status="PROCESSED",kind="BET"\} 1/);
    expect(text).toMatch(/duplicates_detected_total\{source="http",result="replay"\} 1/);
    expect(text).toMatch(/duplicates_detected_total\{source="http",result="conflict"\} 1/);
  });
});
