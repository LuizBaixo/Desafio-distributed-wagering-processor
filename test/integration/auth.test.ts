import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closePools, migrateUp, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { startTestApp, type TestApp } from "../helpers/http";
import { TEST_AUDIENCE, TEST_ISSUER, startTestIdp, type TestIdp } from "../helpers/oidc";
import { getJson, postWager } from "../helpers/wager-http";

let idp: TestIdp;
let app: TestApp;
let base: string;

beforeAll(async () => {
  await migrateUp();
  idp = await startTestIdp();
  app = await startTestApp({
    AUTH_MODE: "oidc",
    OIDC_ISSUER: TEST_ISSUER,
    OIDC_AUDIENCE: TEST_AUDIENCE,
    OIDC_JWKS_URL: idp.jwksUrl,
  });
  base = app.baseUrl;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await app.close();
  await idp.stop();
  await closePools();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const providerToken = (providerId: string) => idp.sign({ provider_id: providerId });
const adminToken = () => idp.sign({ scope: "openid wallet:admin" });

async function wagerFor(providerId: string, token?: string) {
  const w = await createWalletDirect("100.00");
  const cmd = buildWagerCommand({ providerId, walletId: w.walletId, playerId: w.playerId });
  return { w, cmd, res: await postWager(base, cmd, { headers: token ? bearer(token) : {} }) };
}

describe("401 UNAUTHORIZED", () => {
  test("sem token", async () => {
    const { res } = await wagerFor("provider-a");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });

  test("token expirado", async () => {
    const token = await idp.sign({ provider_id: "provider-a" }, { expiresIn: -60 });
    expect((await wagerFor("provider-a", token)).res.status).toBe(401);
  });

  test("issuer errado", async () => {
    const token = await idp.sign({ provider_id: "provider-a" }, { issuer: "https://evil/" });
    expect((await wagerFor("provider-a", token)).res.status).toBe(401);
  });

  test("assinatura de outra chave, e Authorization que não é Bearer", async () => {
    const forged = await idp.sign({ provider_id: "provider-a" }, { key: "other" });
    expect((await wagerFor("provider-a", forged)).res.status).toBe(401);
    const w = await createWalletDirect("10.00");
    const res = await fetch(`${base}/wallets/${w.walletId}`, { headers: { authorization: "Basic abc" } });
    expect(res.status).toBe(401);
  });

  test("a mensagem não revela o motivo", async () => {
    const token = await idp.sign({ provider_id: "provider-a" }, { expiresIn: -60 });
    const { res } = await wagerFor("provider-a", token);
    expect(JSON.stringify(res.body)).not.toMatch(/exp|issuer|signature/i);
  });

  test("401 vem antes de 400: guard roda antes do pipe de UUID", async () => {
    expect((await fetch(`${base}/wallets/nao-e-uuid`)).status).toBe(401);
  });
});

describe("provider_id", () => {
  test("POST com provider_id igual ao body: 200", async () => {
    const { res } = await wagerFor("provider-a", await providerToken("provider-a"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PROCESSED");
  });

  test("POST com provider_id diferente do body: 403 PROVIDER_MISMATCH e nada é gravado", async () => {
    const { res, w } = await wagerFor("provider-b", await providerToken("provider-a"));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PROVIDER_MISMATCH");
    const wallet = await fetch(`${base}/wallets/${w.walletId}`, { headers: bearer(await adminToken()) });
    expect(((await wallet.json()) as { balance: { amount: string } }).balance.amount).toBe("100.00");
  });

  test("token sem provider_id não age como provedor nenhum", async () => {
    const { res } = await wagerFor("provider-a", await adminToken());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PROVIDER_MISMATCH");
  });

  test("GET /wagering/transactions/:id: dono vê, outro provedor recebe 404 igual ao inexistente", async () => {
    const { res } = await wagerFor("provider-a", await providerToken("provider-a"));
    const id = res.body.transactionId as string;

    const own = await fetch(`${base}/wagering/transactions/${id}`, { headers: bearer(await providerToken("provider-a")) });
    expect(own.status).toBe(200);

    const other = await fetch(`${base}/wagering/transactions/${id}`, { headers: bearer(await providerToken("provider-b")) });
    const missing = await fetch(`${base}/wagering/transactions/${crypto.randomUUID()}`, {
      headers: bearer(await providerToken("provider-b")),
    });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  test("GET /providers/:providerId/...: igual ao claim 200, diferente 403", async () => {
    const { cmd } = await wagerFor("provider-a", await providerToken("provider-a"));
    const path = (p: string) => `/providers/${p}/wagering/transactions/${cmd.externalTransactionId}`;

    const ok = await fetch(`${base}${path("provider-a")}`, { headers: bearer(await providerToken("provider-a")) });
    expect(ok.status).toBe(200);

    const denied = await fetch(`${base}${path("provider-a")}`, { headers: bearer(await providerToken("provider-b")) });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("PROVIDER_MISMATCH");
  });
});

describe("wallet:admin", () => {
  const routes = (id: string): Array<[string, string, unknown?]> => [
    ["GET", `/wallets/${id}`],
    ["GET", `/wallets/${id}/ledger`],
    ["POST", `/wallets/${id}/reconciliation`],
    ["POST", "/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "1.00", currency: "BRL" } }],
  ];
  const call = (token: string, [method, path, body]: [string, string, unknown?]) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...bearer(token), "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  test("token de provedor, sem o scope, recebe 403 FORBIDDEN_SCOPE em todas as rotas /wallets*", async () => {
    const w = await createWalletDirect("10.00");
    for (const route of routes(w.walletId)) {
      const res = await call(await providerToken("provider-a"), route);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN_SCOPE");
    }
  });

  test("com wallet:admin as rotas respondem normalmente", async () => {
    const w = await createWalletDirect("10.00");
    const token = await adminToken();
    expect((await call(token, ["GET", `/wallets/${w.walletId}`])).status).toBe(200);
    expect((await call(token, ["GET", `/wallets/${w.walletId}/ledger`])).status).toBe(200);
    expect((await call(token, ["POST", `/wallets/${w.walletId}/reconciliation`])).status).toBe(200);
    expect((await call(token, routes(w.walletId)[3]!)).status).toBe(201);
  });
});

describe("rotas operacionais e correlation id", () => {
  test("/health e /metrics seguem sem auth", async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });

  test("X-Correlation-Id inválido não é refletido nos eventos; válido é mantido", async () => {
    const token = await providerToken("provider-a");
    const w = await createWalletDirect("100.00");
    const bad = buildWagerCommand({ providerId: "provider-a", walletId: w.walletId, playerId: w.playerId });
    const res = await postWager(base, bad, { headers: { ...bearer(token), "x-correlation-id": "<script>alert(1)</script>" } });
    expect(res.status).toBe(200);
    const { rows } = await (await import("../helpers/db")).ownerPool().query<{ payload: unknown }>(
      "SELECT payload FROM outbox_messages",
    );
    expect(JSON.stringify(rows)).not.toContain("<script>");

    const good = buildWagerCommand({ providerId: "provider-a", walletId: w.walletId, playerId: w.playerId });
    await postWager(base, good, { headers: { ...bearer(token), "x-correlation-id": "corr-123" } });
    const after = await (await import("../helpers/db")).ownerPool().query("SELECT payload FROM outbox_messages");
    expect(JSON.stringify(after.rows)).toContain("corr-123");
  });
});

describe("AUTH_MODE=disabled", () => {
  test("tudo passa sem token (comportamento atual)", async () => {
    const open = await startTestApp();
    try {
      const w = await createWalletDirect("100.00");
      expect((await getJson(open.baseUrl, `/wallets/${w.walletId}`)).status).toBe(200);
      const cmd = buildWagerCommand({ providerId: "qualquer", walletId: w.walletId, playerId: w.playerId });
      expect((await postWager(open.baseUrl, cmd)).status).toBe(200);
    } finally {
      await open.close();
    }
  });
});
