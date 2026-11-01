import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../helpers/http";
import { TEST_AUDIENCE, TEST_ISSUER, startTestIdp, type TestIdp } from "../helpers/oidc";

const WALLET_ID = crypto.randomUUID();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Servidor de JWKS que aceita a conexão e nunca responde. */
function hangingJwks(): { url: string; stop(): void } {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  return { url: `http://127.0.0.1:${server.port}/jwks.json`, stop: () => server.stop(true) };
}

/** Servidor de JWKS que responde sempre 500. */
function brokenJwks(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("internal", { status: 500 }),
  });
  return { url: `http://127.0.0.1:${server.port}/jwks.json`, stop: () => server.stop(true) };
}

async function appWithJwks(jwksUrl: string): Promise<TestApp> {
  return startTestApp({
    AUTH_MODE: "oidc",
    OIDC_ISSUER: TEST_ISSUER,
    OIDC_AUDIENCE: TEST_AUDIENCE,
    OIDC_JWKS_URL: jwksUrl,
  });
}

describe("IdP fora do ar: 503 com Retry-After, nunca 401 nem 200 (A-R2-03)", () => {
  let idp: TestIdp;
  beforeAll(async () => {
    idp = await startTestIdp();
  });
  afterAll(async () => {
    await idp.stop();
  });

  test("JWKS que não responde: 503 em menos de 3 s", async () => {
    const jwks = hangingJwks();
    const app = await appWithJwks(jwks.url);
    try {
      const token = await idp.sign({ provider_id: "provider-a" });
      const started = performance.now();
      const res = await fetch(`${app.baseUrl}/wallets/${WALLET_ID}`, { headers: bearer(token) });
      const elapsed = performance.now() - started;
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INFRA_UNAVAILABLE");
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await app.close();
      jwks.stop();
    }
  });

  test("JWKS respondendo 500: 503", async () => {
    const jwks = brokenJwks();
    const app = await appWithJwks(jwks.url);
    try {
      const token = await idp.sign({ provider_id: "provider-a" });
      const res = await fetch(`${app.baseUrl}/wallets/${WALLET_ID}`, { headers: bearer(token) });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
    } finally {
      await app.close();
      jwks.stop();
    }
  });
});

describe("JWKS ok: assinatura errada continua 401", () => {
  test("token assinado por outra chave com JWKS saudável: 401", async () => {
    const idp = await startTestIdp();
    const app = await appWithJwks(idp.jwksUrl);
    try {
      const forged = await idp.sign({ provider_id: "provider-a" }, { key: "other" });
      const res = await fetch(`${app.baseUrl}/wallets/${WALLET_ID}`, { headers: bearer(forged) });
      expect(res.status).toBe(401);
    } finally {
      await app.close();
      await idp.stop();
    }
  });
});
