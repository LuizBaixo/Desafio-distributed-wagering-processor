import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closePools, migrateUp, resetDb } from "../helpers/db";
import { startTestApp } from "../helpers/http";

// Confirma que o WageringModule está ligado ao AppModule: POST /wagering/transactions responde.

const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  await migrateUp();
  const app = await startTestApp();
  baseUrl = app.baseUrl;
  close = app.close;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await close();
  await closePools();
});

describe("WageringModule ligado ao AppModule", () => {
  test("POST /wagering/transactions com BET responde 200 PROCESSED", async () => {
    const created = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: PLAYER, initialBalance: { amount: "1000.00", currency: "BRL" } }),
    });
    const walletId = ((await created.json()) as { id: string }).id;

    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "provider-a:transaction-wiring-1" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "transaction-wiring-1",
        playerId: PLAYER,
        walletId,
        roundId: "round-987",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
  });
});
