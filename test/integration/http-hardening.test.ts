import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { spawnApp, type AppProcess } from "../helpers/app-process";

/** Porta base do agente (TEST_PORT_BASE) mais um deslocamento próprio deste arquivo. */
const BASE_PORT = Number(process.env.TEST_PORT_BASE ?? 4101) + 50;

async function withApp(port: number, env: Record<string, string>, run: (app: AppProcess) => Promise<void>): Promise<void> {
  const app = await spawnApp({ port, roles: "api", env });
  try {
    await run(app);
  } finally {
    await app.kill();
  }
}

describe("cabeçalhos HTTP (helmet)", () => {
  test("nosniff presente e X-Powered-By ausente, em sucesso e em erro", async () => {
    await withApp(BASE_PORT, { DOCS_ENABLED: "true" }, async (app) => {
      const ok = await fetch(`${app.baseUrl}/health/live`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      expect(ok.headers.get("x-powered-by")).toBeNull();

      const missing = await fetch(`${app.baseUrl}/rota-inexistente`);
      expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
      expect(missing.headers.get("x-powered-by")).toBeNull();
    });
  });
});

describe("limite de body JSON", () => {
  test("body de 100 KB recebe 413 no formato padrão de erro", async () => {
    await withApp(BASE_PORT + 1, {}, async (app) => {
      const body = JSON.stringify({ padding: "x".repeat(100 * 1024) });
      const res = await fetch(`${app.baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toContain("application/json");
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  test("Content-Encoding gzip com bytes inválidos recebe 400 INVALID_PAYLOAD, não 500", async () => {
    await withApp(BASE_PORT + 5, {}, async (app) => {
      const res = await fetch(`${app.baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: "garbage-not-gzip",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: { code: "INVALID_PAYLOAD", message: "invalid payload" } });
    });
  });
});

describe("CSP em /docs", () => {
  test("/docs devolve Content-Security-Policy restrita ao Swagger UI, não vazia", async () => {
    await withApp(BASE_PORT + 4, { DOCS_ENABLED: "true" }, async (app) => {
      const res = await fetch(`${app.baseUrl}/docs`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy");
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("img-src 'self' data:");
    });
  });
});

describe("flag DOCS_ENABLED", () => {
  test("com DOCS_ENABLED=false, /docs e /docs-json respondem 404", async () => {
    await withApp(BASE_PORT + 2, { DOCS_ENABLED: "false" }, async (app) => {
      expect((await fetch(`${app.baseUrl}/docs`)).status).toBe(404);
      expect((await fetch(`${app.baseUrl}/docs-json`)).status).toBe(404);
    });
  });

  test("com DOCS_ENABLED=true, /docs-json responde o OpenAPI", async () => {
    await withApp(BASE_PORT + 3, { DOCS_ENABLED: "true" }, async (app) => {
      const res = await fetch(`${app.baseUrl}/docs-json`);
      expect(res.status).toBe(200);
    });
  });

  test("padrão: ligado fora de production e desligado em production, sem a flag", () => {
    const base = { NODE_ENV: "development", DATABASE_URL: "postgres://wagering_app:Xq7vLm4Wz8Rt2pQ9hBn5KcYe@localhost:5433/wagering", SQS_ENDPOINT: "http://localhost:4567" };
    expect(loadConfig({ ...base }).docsEnabled).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "disabled" }).docsEnabled).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "disabled", DOCS_ENABLED: "true" }).docsEnabled).toBe(true);
  });
});

describe("validação de lock_timeout na UoW", () => {
  // O construtor valida antes de usar o EntityManager, então um stub basta.
  const em = {} as ConstructorParameters<typeof MikroUnitOfWork>[0];

  test("aceita valores no formato <número>ms ou <número>s", () => {
    expect(() => new MikroUnitOfWork(em, "5s")).not.toThrow();
    expect(() => new MikroUnitOfWork(em, "250ms")).not.toThrow();
  });

  test("rejeita valor com injeção de SQL", () => {
    expect(() => new MikroUnitOfWork(em, "5s'; DROP TABLE x;--")).toThrow();
  });

  test("rejeita valor fora do formato, como unidade desconhecida", () => {
    expect(() => new MikroUnitOfWork(em, "5min")).toThrow();
  });
});
