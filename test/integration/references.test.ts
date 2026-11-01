import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/enums";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect, type DirectWallet } from "../helpers/factories";
import { postWager } from "../helpers/wager-http";
import { startWageringTestApp } from "../helpers/wagering-app";

let baseUrl: string;
let close: () => Promise<void>;
let wallet: DirectWallet;

beforeAll(async () => {
  await migrateUp();
  const app = await startWageringTestApp();
  baseUrl = app.baseUrl;
  close = app.close;
});
beforeEach(async () => {
  await resetDb();
  wallet = await createWalletDirect("1000.00");
});
afterEach(async () => {
  await assertLedgerConsistent();
});
afterAll(async () => {
  await close();
  await closePools();
});

const cmd = (o: Partial<WagerCommand> = {}) =>
  buildWagerCommand({ walletId: wallet.walletId, playerId: wallet.playerId, ...o });
const money = (amount: string) => ({ amount, currency: "BRL" });

async function balance(): Promise<string> {
  const r = await ownerPool().query<{ b: string }>(`SELECT balance::text AS b FROM wallets WHERE id = $1`, [wallet.walletId]);
  return r.rows[0]!.b;
}

/** Faz uma BET de 25.00 e devolve o comando (para referenciar o externalTransactionId). */
async function placeBet(): Promise<WagerCommand> {
  const bet = cmd({ money: money("25.00") });
  const res = await postWager(baseUrl, bet);
  expect(res.status).toBe(200);
  return bet;
}

const reversal = (kind: Kind.Refund | Kind.Rollback, of: WagerCommand, amount = "25.00") =>
  cmd({ kind, money: money(amount), referenceExternalTransactionId: of.externalTransactionId });

describe("REFUND and ROLLBACK", () => {
  test("REFUND after BET returns the balance to the initial value", async () => {
    const bet = await placeBet();
    expect(await balance()).toBe("975.00");
    const res = await postWager(baseUrl, reversal(Kind.Refund, bet));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "PROCESSED", balance: { amount: "1000.00" } });
    expect(await balance()).toBe("1000.00");
  });

  test("a second REFUND of the same BET: 422 REFERENCE_ALREADY_REVERSED", async () => {
    const bet = await placeBet();
    await postWager(baseUrl, reversal(Kind.Refund, bet));
    const res = await postWager(baseUrl, reversal(Kind.Refund, bet));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await balance()).toBe("1000.00");
  });

  test("ROLLBACK after the REFUND of the same BET: 422 REFERENCE_ALREADY_REVERSED", async () => {
    const bet = await placeBet();
    await postWager(baseUrl, reversal(Kind.Refund, bet));
    const res = await postWager(baseUrl, reversal(Kind.Rollback, bet));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await balance()).toBe("1000.00");
  });

  test("ROLLBACK of a REFUND: 200 and the balance is debited again", async () => {
    const bet = await placeBet();
    const refund = reversal(Kind.Refund, bet);
    await postWager(baseUrl, refund);
    expect(await balance()).toBe("1000.00");
    const res = await postWager(baseUrl, reversal(Kind.Rollback, refund));
    expect(res.status).toBe(200);
    expect(res.body.balance.amount).toBe("975.00");
    expect(await balance()).toBe("975.00");
  });

  test("ROLLBACK of a BET credits the amount back", async () => {
    const bet = await placeBet();
    const res = await postWager(baseUrl, reversal(Kind.Rollback, bet));
    expect(res.status).toBe(200);
    expect(res.body.balance.amount).toBe("1000.00");
  });

  test("REFUND with another amount: 422 AMOUNT_MISMATCH", async () => {
    const bet = await placeBet();
    const res = await postWager(baseUrl, reversal(Kind.Refund, bet, "20.00"));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("AMOUNT_MISMATCH");
  });

  test("ROLLBACK of a WIN without funds: 422 REVERSAL_INSUFFICIENT_FUNDS, balance 0.00, stored as REJECTED", async () => {
    expect((await postWager(baseUrl, cmd({ money: money("1000.00") }))).body.balance.amount).toBe("0.00");
    const win = cmd({ kind: Kind.Win, money: money("900.00") });
    expect((await postWager(baseUrl, win)).body.balance.amount).toBe("900.00");
    expect((await postWager(baseUrl, cmd({ money: money("900.00") }))).body.balance.amount).toBe("0.00");

    const rollback = reversal(Kind.Rollback, win, "900.00");
    const res = await postWager(baseUrl, rollback);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS", balance: { amount: "0.00" } });
    expect(await balance()).toBe("0.00");

    const row = await ownerPool().query(
      `SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = $1`,
      [rollback.externalTransactionId],
    );
    expect(row.rows[0]).toEqual({ status: "REJECTED", failure_code: "REVERSAL_INSUFFICIENT_FUNDS" });
  });

  test("WIN referencing an already reversed BET is rejected and pays nothing", async () => {
    const bet = await placeBet();
    await postWager(baseUrl, reversal(Kind.Refund, bet));
    const res = await postWager(
      baseUrl,
      cmd({ kind: Kind.Win, money: money("50.00"), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await balance()).toBe("1000.00");
  });

  test("REFUND of a rejected BET: 422 REFERENCE_NOT_PROCESSED", async () => {
    const bet = cmd({ money: money("5000.00") });
    expect((await postWager(baseUrl, bet)).status).toBe(422);
    const res = await postWager(baseUrl, reversal(Kind.Refund, bet, "5000.00"));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("REFERENCE_NOT_PROCESSED");
  });
});

describe("references that arrive late", () => {
  test("REFUND before its BET: 202 PENDING_REFERENCE; when the BET arrives the pending becomes due", async () => {
    const bet = cmd({ money: money("25.00") });
    const refund = reversal(Kind.Refund, bet);

    const pending = await postWager(baseUrl, refund);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ status: "PENDING_REFERENCE", balance: null, idempotentReplay: false });

    const waiting = await ownerPool().query(`SELECT next_attempt_at > now() AS future FROM wager_transactions WHERE id = $1`, [pending.body.transactionId]);
    expect(waiting.rows[0].future).toBe(true);

    expect((await postWager(baseUrl, bet)).status).toBe(200);
    const due = await ownerPool().query(`SELECT next_attempt_at <= now() AS due FROM wager_transactions WHERE id = $1`, [pending.body.transactionId]);
    expect(due.rows[0].due).toBe(true);

    // Replay do pendente: 202 de novo, sem reprocessar (quem reprocessa é o worker).
    const replay = await postWager(baseUrl, refund);
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(await balance()).toBe("975.00");
  });

  test("a chain out of order: ROLLBACK of a REFUND whose BET has not arrived is pending", async () => {
    const bet = cmd({ money: money("25.00") });
    const refund = reversal(Kind.Refund, bet);
    const first = await postWager(baseUrl, refund);
    expect(first.status).toBe(202);
    const rollback = await postWager(baseUrl, reversal(Kind.Rollback, refund));
    expect(rollback.status).toBe(202);
    expect(rollback.body.status).toBe("PENDING_REFERENCE");
  });
});

describe("database defense", () => {
  test("a second reversal inserted straight into SQL after a PROCESSED one is rejected with 23505", async () => {
    const bet = await placeBet();
    const refund = await postWager(baseUrl, reversal(Kind.Refund, bet));
    expect(refund.status).toBe(200);

    const betRow = await ownerPool().query<{ id: string }>(
      `SELECT id FROM wager_transactions WHERE external_transaction_id = $1`,
      [bet.externalTransactionId],
    );
    const betId = betRow.rows[0]!.id;
    const insert = ownerPool().query(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, reference_external_transaction_id,
          reference_transaction_id, status, result_balance, result_currency, processed_at)
       VALUES ($1, 'provider-a', 'sql-refund', 'sql-refund', $2, $3, $4, 'round-1', 'game-1', 'REFUND',
               '25.00', 'BRL', $5, $6, 'PROCESSED', '1000.00', 'BRL', now())`,
      [crypto.randomUUID(), "e".repeat(64), wallet.walletId, wallet.playerId, bet.externalTransactionId, betId],
    );
    await expect(insert).rejects.toMatchObject({ code: "23505" });
  });
});
