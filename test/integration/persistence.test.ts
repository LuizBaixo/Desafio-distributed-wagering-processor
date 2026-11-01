import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ConcurrencyViolationError, DuplicateWalletError, TransientInfrastructureError } from "../../src/application/errors";
import type { TransactionScope } from "../../src/application/ports/unit-of-work";
import { WalletBalanceChanged } from "../../src/domain/events/events";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/money/money";
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "../../src/domain/wagering/enums";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";
import { LedgerDirection } from "../../src/domain/wagering/enums";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { mapPgError } from "../../src/infrastructure/persistence/pg-error-mapper";
import { Uuid7Generator } from "../../src/infrastructure/system/uuid-generator";
import { SystemClock } from "../../src/infrastructure/system/clock";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, createAppOrm, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { createWalletDirect } from "../helpers/factories";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const ids = new Uuid7Generator();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = "a".repeat(64);

let orm: MikroORM;
let uow: MikroUnitOfWork;

beforeAll(async () => {
  await migrateUp();
  orm = await createAppOrm();
  uow = new MikroUnitOfWork(orm.em);
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await orm.close(true);
  await closePools();
});

function openWallet(balance = "100.00", playerId = ids.next()): Wallet {
  return Wallet.open({ id: ids.next(), playerId, initialBalance: brl(balance), at: new Date() });
}

function bet(wallet: Wallet, amount = "25.00"): WagerTransaction {
  return WagerTransaction.create({
    id: ids.next(),
    providerId: "provider-a",
    externalTransactionId: `ext-${ids.next()}`,
    idempotencyKey: `key-${ids.next()}`,
    payloadHash: hash,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl(amount),
    createdAt: new Date(),
  });
}

/** Wallet + BET + débito + lançamento + evento, tudo na mesma transação. */
async function betFlow(scope: TransactionScope): Promise<{ wallet: Wallet; tx: WagerTransaction }> {
  const wallet = openWallet();
  await scope.wallets.insert(wallet);
  const tx = bet(wallet);
  await scope.transactions.insert(tx);
  const expected = wallet.version;
  const entry = wallet.debit({ money: tx.money, transactionId: tx.id, entryId: ids.next(), at: new Date() });
  await scope.wallets.saveBalance(wallet, expected);
  await scope.ledger.append(entry);
  tx.markProcessed(undefined, wallet.balance, new Date());
  await scope.transactions.update(tx);
  const event = WalletBalanceChanged.from(wallet, entry, {
    eventId: ids.next(),
    correlationId: "corr-1",
    occurredAt: new Date(),
  });
  await scope.outbox.enqueue(OutboxMessage.enqueue(event));
  return { wallet, tx };
}

async function counts(): Promise<Record<string, string>> {
  const r = await ownerPool().query<Record<string, string>>(`
    SELECT (SELECT count(*) FROM wallets)::text AS wallets,
           (SELECT count(*) FROM wager_transactions)::text AS transactions,
           (SELECT count(*) FROM wallet_ledger_entries)::text AS ledger,
           (SELECT count(*) FROM outbox_messages)::text AS outbox`);
  return r.rows[0]!;
}

describe("UnitOfWork atomicity", () => {
  test("throwing after writes to 4 tables persists nothing", async () => {
    await expect(
      uow.run(async (scope) => {
        await betFlow(scope);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await counts()).toEqual({ wallets: "0", transactions: "0", ledger: "0", outbox: "0" });
  });

  test("the same flow without error persists all 4 rows and is consistent", async () => {
    const { wallet, tx } = await uow.run(betFlow);
    expect(await counts()).toEqual({ wallets: "1", transactions: "1", ledger: "1", outbox: "1" });

    const loaded = await uow.run(async (s) => ({
      wallet: await s.wallets.findById(wallet.id),
      tx: await s.transactions.findById(tx.id),
    }));
    expect(loaded.wallet?.balance.amount).toBe("75.00");
    expect(loaded.wallet?.version).toBe(2);
    expect(loaded.tx?.status).toBe(Status.Processed);
    expect(loaded.tx?.resultBalance?.amount).toBe("75.00");
  });

  test("work error is returned as is when it is not an infrastructure error", async () => {
    class Custom extends Error {}
    await expect(uow.run(async () => Promise.reject(new Custom("x")))).rejects.toBeInstanceOf(Custom);
  });
});

describe("wallet locking", () => {
  test("lockForUpdate on the same wallet: the second waits for the first commit", async () => {
    const wallet = openWallet();
    await uow.run((s) => s.wallets.insert(wallet));

    const events: string[] = [];
    const first = uow.run(async (s) => {
      await s.wallets.lockForUpdate(wallet.id);
      events.push("A locked");
      await sleep(400);
      events.push("A releasing");
    });
    await sleep(100);
    const second = uow.run(async (s) => {
      events.push("B asking");
      await s.wallets.lockForUpdate(wallet.id);
      events.push("B locked");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["A locked", "B asking", "A releasing", "B locked"]);
  });

  test("lockForUpdate on different wallets does not block", async () => {
    const w1 = openWallet();
    const w2 = openWallet();
    await uow.run(async (s) => {
      await s.wallets.insert(w1);
      await s.wallets.insert(w2);
    });

    const events: string[] = [];
    const first = uow.run(async (s) => {
      await s.wallets.lockForUpdate(w1.id);
      events.push("A locked");
      await sleep(500);
      events.push("A releasing");
    });
    await sleep(100);
    const second = uow.run(async (s) => {
      await s.wallets.lockForUpdate(w2.id);
      events.push("B locked");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["A locked", "B locked", "A releasing"]);
  });

  test("lockForUpdate returns null for a missing wallet; lockForShare locks an existing one", async () => {
    const wallet = openWallet();
    await uow.run((s) => s.wallets.insert(wallet));
    const r = await uow.run(async (s) => ({
      missing: await s.wallets.lockForUpdate(ids.next()),
      shared: await s.wallets.lockForShare(wallet.id),
    }));
    expect(r.missing).toBeNull();
    expect(r.shared?.id).toBe(wallet.id);
  });

  test("saveBalance with a stale expectedVersion throws ConcurrencyViolationError", async () => {
    const wallet = openWallet();
    await uow.run((s) => s.wallets.insert(wallet));
    await expect(uow.run((s) => s.wallets.saveBalance(wallet, 5))).rejects.toBeInstanceOf(
      ConcurrencyViolationError,
    );
  });

  test("insert of a second wallet for the same player and currency throws DuplicateWalletError", async () => {
    const first = openWallet("0.00");
    await uow.run((s) => s.wallets.insert(first));
    const second = openWallet("0.00", first.playerId);
    await expect(uow.run((s) => s.wallets.insert(second))).rejects.toBeInstanceOf(DuplicateWalletError);
  });
});

describe("inbox", () => {
  test("tryReceive returns new, then duplicate", async () => {
    const msg = () =>
      InboxMessage.receive({
        messageId: "m1",
        consumerName: "wager-transactions-consumer",
        payloadHash: hash,
        receivedAt: new Date(),
      });
    expect(await uow.run((s) => s.inbox.tryReceive(msg()))).toBe("new");
    expect(await uow.run((s) => s.inbox.tryReceive(msg()))).toBe("duplicate");
  });

  test("tryReceive flags a repeated messageId whose payload_hash differs as conflict", async () => {
    const msg = (payloadHash: string) =>
      InboxMessage.receive({
        messageId: "m2",
        consumerName: "wager-transactions-consumer",
        payloadHash,
        receivedAt: new Date(),
      });
    expect(await uow.run((s) => s.inbox.tryReceive(msg(hash)))).toBe("new");
    expect(await uow.run((s) => s.inbox.tryReceive(msg("f".repeat(64))))).toBe("conflict");
    expect(await uow.run((s) => s.inbox.tryReceive(msg(hash)))).toBe("duplicate");
  });
});

describe("outbox", () => {
  const event = (aggregateId = ids.next(), at = new Date()) =>
    OutboxMessage.enqueue(
      WalletBalanceChanged.from(
        openWalletWithId(aggregateId),
        WalletLedgerEntry.create({
          id: ids.next(),
          walletId: aggregateId,
          transactionId: ids.next(),
          direction: LedgerDirection.Credit,
          money: brl("1.00"),
          balanceBefore: brl("0.00"),
          balanceAfter: brl("1.00"),
          createdAt: at,
        }),
        { eventId: ids.next(), correlationId: "c", occurredAt: at },
      ),
    );

  function openWalletWithId(id: string): Wallet {
    return Wallet.open({ id, playerId: ids.next(), initialBalance: brl("1.00"), at: new Date() });
  }

  test("claimDue leases rows, skips leased ones, and release/markPublished update them", async () => {
    const now = new Date();
    const m1 = event(undefined, new Date(now.getTime() - 2000));
    const m2 = event(undefined, new Date(now.getTime() - 1000));
    await uow.run(async (s) => {
      await s.outbox.enqueue(m1);
      await s.outbox.enqueue(m2);
    });

    const claimed = await uow.run((s) => s.outbox.claimDue(10, 30, now));
    expect(claimed.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(claimed[0]?.payload).toMatchObject({ eventType: "WalletBalanceChanged", version: 1 });

    // Lease ativo: ninguém mais pega.
    expect(await uow.run((s) => s.outbox.claimDue(10, 30, now))).toHaveLength(0);

    await uow.run((s) => s.outbox.markPublished(m1.id, now));
    const retry = claimed[1]!;
    retry.scheduleRetry(now);
    await uow.run((s) => s.outbox.release(retry));

    const row = await ownerPool().query(
      `SELECT id, attempts, locked_until, published_at IS NOT NULL AS published FROM outbox_messages ORDER BY occurred_at`,
    );
    expect(row.rows[0]).toMatchObject({ id: m1.id, published: true });
    expect(row.rows[1]).toMatchObject({ id: m2.id, attempts: 1, locked_until: null, published: false });

    // Retry ainda no futuro: não é elegível agora, mas é depois do backoff.
    expect(await uow.run((s) => s.outbox.claimDue(10, 30, now))).toHaveLength(0);
    const later = new Date(now.getTime() + 5000);
    expect((await uow.run((s) => s.outbox.claimDue(10, 30, later))).map((m) => m.id)).toEqual([m2.id]);
  });

  test("an expired lease makes the row claimable again", async () => {
    const now = new Date();
    const m = event(undefined, new Date(now.getTime() - 1000));
    await uow.run((s) => s.outbox.enqueue(m));
    expect(await uow.run((s) => s.outbox.claimDue(10, 30, now))).toHaveLength(1);
    const afterLease = new Date(now.getTime() + 31_000);
    expect(await uow.run((s) => s.outbox.claimDue(10, 30, afterLease))).toHaveLength(1);
  });

  test("two concurrent claimDue never return the same row (SKIP LOCKED)", async () => {
    const now = new Date();
    const rows = Array.from({ length: 20 }, (_, i) => event(undefined, new Date(now.getTime() - 20_000 + i)));
    await uow.run(async (s) => {
      for (const r of rows) await s.outbox.enqueue(r);
    });
    const [a, b] = await Promise.all([
      uow.run((s) => s.outbox.claimDue(20, 30, now)),
      uow.run((s) => s.outbox.claimDue(20, 30, now)),
    ]);
    const all = [...a, ...b].map((m) => m.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(20);
  });

  test("oldestPendingAgeSeconds", async () => {
    const now = new Date();
    expect(await uow.run((s) => s.outbox.oldestPendingAgeSeconds(now))).toBe(0);
    await uow.run((s) => s.outbox.enqueue(event(undefined, new Date(now.getTime() - 10_000))));
    const age = await uow.run((s) => s.outbox.oldestPendingAgeSeconds(now));
    expect(age).toBeGreaterThanOrEqual(10);
    expect(age).toBeLessThan(11);
  });
});

describe("pending reference queries", () => {
  async function pendingRefund(scope: TransactionScope, wallet: Wallet, refExternal: string, nextAt: Date) {
    const tx = WagerTransaction.create({
      id: ids.next(),
      providerId: "provider-a",
      externalTransactionId: `ext-${ids.next()}`,
      idempotencyKey: `key-${ids.next()}`,
      payloadHash: hash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: Kind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: refExternal,
      createdAt: new Date(),
    });
    tx.markPendingReference(nextAt);
    await scope.transactions.insert(tx);
    return tx;
  }

  test("markDependentsDue and claimDuePending", async () => {
    const wallet = openWallet();
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    const [p1, p2] = await uow.run(async (s) => {
      await s.wallets.insert(wallet);
      return [await pendingRefund(s, wallet, "bet-1", future), await pendingRefund(s, wallet, "bet-2", future)] as const;
    });

    expect(await uow.run((s) => s.transactions.claimDuePending(10, 30, now))).toHaveLength(0);

    const touched = await uow.run((s) => s.transactions.markDependentsDue("provider-a", "bet-1", now));
    expect(touched).toBe(1);

    const claimed = await uow.run((s) => s.transactions.claimDuePending(10, 30, now));
    expect(claimed).toEqual([{ id: p1.id, walletId: wallet.id }]);
    // Lease ativo: não reaparece.
    expect(await uow.run((s) => s.transactions.claimDuePending(10, 30, now))).toHaveLength(0);
    // Lease expirado: reaparece.
    const later = new Date(now.getTime() + 31_000);
    expect((await uow.run((s) => s.transactions.claimDuePending(10, 30, later))).map((c) => c.id)).toEqual([p1.id]);
    expect(p2.status).toBe(Status.PendingReference);
  });

  test("finders, lockById and isReversed", async () => {
    const wallet = openWallet();
    const target = bet(wallet);
    target.markProcessed(undefined, brl("75.00"), new Date());
    const refund = WagerTransaction.create({
      id: ids.next(),
      providerId: "provider-a",
      externalTransactionId: "refund-1",
      idempotencyKey: "refund-key-1",
      payloadHash: hash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: Kind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: target.externalTransactionId,
      createdAt: new Date(),
    });
    refund.markProcessed(target.id, brl("100.00"), new Date());

    await uow.run(async (s) => {
      await s.wallets.insert(wallet);
      await s.transactions.insert(target);
      await s.transactions.insert(refund);
    });

    const r = await uow.run(async (s) => ({
      byKey: await s.transactions.findByIdempotencyKey("provider-a", target.idempotencyKey),
      byExt: await s.transactions.findByExternalId("provider-a", target.externalTransactionId),
      otherProvider: await s.transactions.findByExternalId("provider-b", target.externalTransactionId),
      locked: await s.transactions.lockById(target.id),
      reversed: await s.transactions.isReversed(target.id),
      notReversed: await s.transactions.isReversed(refund.id),
    }));
    expect(r.byKey?.id).toBe(target.id);
    expect(r.byExt?.id).toBe(target.id);
    expect(r.otherProvider).toBeNull();
    expect(r.locked?.id).toBe(target.id);
    expect(r.reversed).toBe(true);
    expect(r.notReversed).toBe(false);
  });
});

describe("ledger repository", () => {
  test("list pages by seq and totals sums in SQL", async () => {
    const { walletId } = await createWalletDirect("1000.00");
    const wallet = (await uow.run((s) => s.wallets.findById(walletId)))!;
    const before = wallet.version;
    await uow.run(async (s) => {
      for (const amount of ["0.10", "0.20", "0.30"]) {
        const tx = bet(wallet, amount);
        await s.transactions.insert(tx);
        const v = wallet.version;
        const entry = wallet.debit({ money: tx.money, transactionId: tx.id, entryId: ids.next(), at: new Date() });
        await s.wallets.saveBalance(wallet, v);
        await s.ledger.append(entry);
      }
    });
    expect(wallet.version).toBe(before + 3);

    const page1 = await uow.run((s) => s.ledger.list(walletId, undefined, 2));
    expect(page1).toHaveLength(2);
    expect(page1[0]?.direction).toBe(LedgerDirection.Credit);
    const page2 = await uow.run((s) => s.ledger.list(walletId, page1[1]!.seq, 2));
    expect(page2).toHaveLength(2);
    expect(page2[0]!.seq! > page1[1]!.seq!).toBe(true);

    const totals = await uow.run((s) => s.ledger.totals(walletId));
    expect(totals.credits.amount).toBe("1000.00");
    expect(totals.debits.amount).toBe("0.60");
    expect(totals.count).toBe(4);
    expect(totals.lastBalanceAfter?.amount).toBe("999.40");
    await assertLedgerConsistent();
  });

  test("totals of a wallet without entries are zero; of a missing wallet throws", async () => {
    const wallet = openWallet("0.00");
    await uow.run((s) => s.wallets.insert(wallet));
    const t = await uow.run((s) => s.ledger.totals(wallet.id));
    expect(t.credits.amount).toBe("0.00");
    expect(t.debits.amount).toBe("0.00");
    expect(t.count).toBe(0);
    expect(t.lastBalanceAfter).toBeUndefined();
    await expect(uow.run((s) => s.ledger.totals(ids.next()))).rejects.toThrow();
  });
});

describe("NUMERIC round trip", () => {
  test("0.10 comes back exactly as the string 0.10 for wallet, transaction and ledger", async () => {
    const wallet = openWallet("0.10");
    const tx = bet(wallet, "0.10");
    tx.markProcessed(undefined, brl("0.00"), new Date());
    await uow.run(async (s) => {
      await s.wallets.insert(wallet);
      await s.transactions.insert(tx);
      const v = wallet.version;
      const entry = wallet.debit({ money: tx.money, transactionId: tx.id, entryId: ids.next(), at: new Date() });
      await s.wallets.saveBalance(wallet, v);
      await s.ledger.append(entry);
    });

    const other = openWallet("0.10");
    await uow.run((s) => s.wallets.insert(other));

    const loaded = await uow.run(async (s) => ({
      wallet: await s.wallets.findById(other.id),
      tx: await s.transactions.findById(tx.id),
      ledger: await s.ledger.list(wallet.id, undefined, 10),
    }));
    expect(loaded.wallet?.balance.amount).toBe("0.10");
    expect(loaded.wallet?.balance.toJSON()).toEqual({ amount: "0.10", currency: "BRL" });
    expect(loaded.tx?.money.amount).toBe("0.10");
    expect(loaded.tx?.resultBalance?.amount).toBe("0.00");
    expect(loaded.ledger[0]?.money.amount).toBe("0.10");
    expect(loaded.ledger[0]?.balanceBefore.amount).toBe("0.10");
    expect(loaded.ledger[0]?.balanceAfter.amount).toBe("0.00");
  });

  test("largest NUMERIC(20,2) value survives without precision loss", async () => {
    const wallet = openWallet("999999999999999999.99");
    await uow.run((s) => s.wallets.insert(wallet));
    const loaded = await uow.run((s) => s.wallets.findById(wallet.id));
    expect(loaded?.balance.amount).toBe("999999999999999999.99");
  });

  test("WagerTransaction round trip keeps every field", async () => {
    const wallet = openWallet();
    const t = new Date("2026-10-31T12:00:00.000Z");
    const tx = WagerTransaction.create({
      id: ids.next(),
      providerId: "provider-a",
      externalTransactionId: "ext-rt",
      idempotencyKey: "key-rt",
      payloadHash: hash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-9",
      gameId: "game-9",
      kind: Kind.Refund,
      money: brl("12.34"),
      referenceExternalTransactionId: "bet-ext",
      createdAt: t,
    });
    tx.markPendingReference(new Date("2026-10-31T12:00:05.000Z"));
    await uow.run(async (s) => {
      await s.wallets.insert(wallet);
      await s.transactions.insert(tx);
    });
    const loaded = (await uow.run((s) => s.transactions.findById(tx.id)))!;
    expect(loaded.kind).toBe(Kind.Refund);
    expect(loaded.status).toBe(Status.PendingReference);
    expect(loaded.referenceExternalTransactionId).toBe("bet-ext");
    expect(loaded.roundId).toBe("round-9");
    expect(loaded.money.toJSON()).toEqual({ amount: "12.34", currency: "BRL" });
    expect(loaded.createdAt).toEqual(t);
    expect(loaded.nextAttemptAt).toEqual(new Date("2026-10-31T12:00:05.000Z"));
    expect(loaded.attempts).toBe(0);
    expect(loaded.resultBalance).toBeUndefined();
  });
});

describe("assertLedgerConsistent", () => {
  test("passes for consistent wallets", async () => {
    await createWalletDirect("100.00");
    await createWalletDirect("0.00");
    await assertLedgerConsistent();
  });

  test("fails and lists the wallet when balance diverges from the ledger", async () => {
    const { walletId } = await createWalletDirect("100.00");
    await ownerPool().query(`UPDATE wallets SET balance = '90.00' WHERE id = $1`, [walletId]);
    await expect(assertLedgerConsistent()).rejects.toThrow(walletId);
  });

  test("fails for a wallet with balance but no ledger", async () => {
    const { walletId } = await createWalletDirect("0.00");
    await ownerPool().query(`UPDATE wallets SET balance = '5.00' WHERE id = $1`, [walletId]);
    await expect(assertLedgerConsistent()).rejects.toThrow(walletId);
  });
});

describe("mapPgError", () => {
  test("55P03 (lock timeout) becomes TransientInfrastructureError", () => {
    expect(mapPgError({ code: "55P03" })).toBeInstanceOf(TransientInfrastructureError);
  });

  test("other transient codes become TransientInfrastructureError", () => {
    for (const code of ["40001", "40P01", "57P01", "ECONNREFUSED", "ECONNRESET"]) {
      expect(mapPgError({ code })).toBeInstanceOf(TransientInfrastructureError);
    }
  });

  test("pool/connection errors become TransientInfrastructureError", () => {
    expect(mapPgError(new Error("Connection terminated unexpectedly"))).toBeInstanceOf(TransientInfrastructureError);
    expect(mapPgError(new Error("timeout exceeded when trying to connect"))).toBeInstanceOf(
      TransientInfrastructureError,
    );
    expect(mapPgError(new Error("Unable to acquire a connection"))).toBeInstanceOf(TransientInfrastructureError);
  });

  test("anything else passes through unchanged", () => {
    const unique = Object.assign(new Error("dup"), { code: "23505" });
    expect(mapPgError(unique)).toBe(unique);
    const plain = new Error("plain");
    expect(mapPgError(plain)).toBe(plain);
  });

  test("a lock_timeout in a real transaction surfaces as TransientInfrastructureError", async () => {
    const wallet = openWallet();
    await uow.run((s) => s.wallets.insert(wallet));
    // Segura o lock por mais que o lock_timeout de 5s da UoW? Evita teste lento: usa timeout curto manual.
    const holder = uow.run(async (s) => {
      await s.wallets.lockForUpdate(wallet.id);
      await sleep(700);
    });
    await sleep(100);
    const waiter = orm.em.fork().transactional(async (em) => {
      await em.execute("SET LOCAL lock_timeout = '200ms'");
      await em.execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [wallet.id]);
    });
    const err = await waiter.catch((e: unknown) => e);
    expect(mapPgError(err)).toBeInstanceOf(TransientInfrastructureError);
    await holder;
  });
});
