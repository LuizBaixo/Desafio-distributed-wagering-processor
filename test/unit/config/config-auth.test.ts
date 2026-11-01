import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/config/config";

// Senha forte de 24 caracteres: a validação de produção exige no mínimo 12.
const STRONG_PASSWORD = "Xq7vLm4Wz8Rt2pQ9hBn5KcYe";
const BASE = {
  NODE_ENV: "development",
  DATABASE_URL: `postgres://wagering_app:${STRONG_PASSWORD}@db.internal:5432/wagering`,
  SQS_ENDPOINT: "http://sqs.internal:4566",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
};
const OIDC = {
  AUTH_MODE: "oidc",
  OIDC_ISSUER: "https://idp.example.com/",
  OIDC_AUDIENCE: "wagering",
  OIDC_JWKS_URL: "https://idp.example.com/.well-known/jwks.json",
};

describe("loadConfig: AUTH_MODE", () => {
  test("sem AUTH_MODE fora de produção, auth fica disabled", () => {
    expect(loadConfig({ ...BASE }).auth).toEqual({ mode: "disabled" });
  });

  test("oidc exige OIDC_ISSUER, OIDC_AUDIENCE e OIDC_JWKS_URL", () => {
    for (const missing of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URL"]) {
      const env: Record<string, string> = { ...BASE, ...OIDC };
      delete env[missing];
      expect(() => loadConfig(env)).toThrow(missing);
    }
  });

  test("oidc completo devolve issuer, audience, jwksUrl e timeout padrão de 2000 ms", () => {
    expect(loadConfig({ ...BASE, ...OIDC }).auth).toEqual({
      mode: "oidc",
      issuer: "https://idp.example.com/",
      audience: "wagering",
      jwksUrl: "https://idp.example.com/.well-known/jwks.json",
      jwksTimeoutMs: 2000,
    });
  });

  test("OIDC_JWKS_TIMEOUT_MS configura o timeout do JWKS", () => {
    const auth = loadConfig({ ...BASE, ...OIDC, OIDC_JWKS_TIMEOUT_MS: "500" }).auth;
    expect(auth).toMatchObject({ mode: "oidc", jwksTimeoutMs: 500 });
  });

  test("OIDC_JWKS_TIMEOUT_MS inválido falha", () => {
    expect(() => loadConfig({ ...BASE, ...OIDC, OIDC_JWKS_TIMEOUT_MS: "0" })).toThrow("OIDC_JWKS_TIMEOUT_MS");
  });

  test("fora de produção, http em OIDC_JWKS_URL e OIDC_ISSUER é aceito", () => {
    const auth = loadConfig({
      ...BASE,
      ...OIDC,
      OIDC_ISSUER: "http://idp.test/",
      OIDC_JWKS_URL: "http://127.0.0.1:9999/jwks.json",
    }).auth;
    expect(auth).toMatchObject({ mode: "oidc", jwksUrl: "http://127.0.0.1:9999/jwks.json" });
  });

  test("valor inválido de AUTH_MODE falha", () => {
    expect(() => loadConfig({ ...BASE, AUTH_MODE: "basic" })).toThrow("AUTH_MODE");
  });
});

describe("loadConfig: NODE_ENV=production", () => {
  const PROD = { ...BASE, NODE_ENV: "production" };

  test("AUTH_MODE ausente falha", () => {
    expect(() => loadConfig(PROD)).toThrow("AUTH_MODE");
  });

  test("AUTH_MODE=disabled explícito sobe e marca o modo", () => {
    const cfg = loadConfig({ ...PROD, AUTH_MODE: "disabled" });
    expect(cfg.auth).toEqual({ mode: "disabled" });
    expect(cfg.production).toBe(true);
  });

  test.each(["postgres:postgres", ":owner@", ":app@"])("DATABASE_URL com senha padrão %s falha", (needle) => {
    const url = needle === "postgres:postgres" ? "postgres://postgres:postgres@db:5432/w" : `postgres://u${needle}db:5432/w`;
    expect(() => loadConfig({ ...PROD, ...OIDC, DATABASE_URL: url })).toThrow("DATABASE_URL");
  });

  test("a mensagem de erro não repete a senha", () => {
    try {
      loadConfig({ ...PROD, ...OIDC, DATABASE_URL: "postgres://wagering_app:app@db:5432/w" });
      throw new Error("deveria falhar");
    } catch (e) {
      expect(String(e)).not.toContain("wagering_app:app@");
    }
  });

  test("AWS_ACCESS_KEY_ID=test falha", () => {
    expect(() => loadConfig({ ...PROD, ...OIDC, AWS_ACCESS_KEY_ID: "test" })).toThrow("AWS_ACCESS_KEY_ID");
  });

  test("configuração segura com oidc passa", () => {
    expect(loadConfig({ ...PROD, ...OIDC }).auth.mode).toBe("oidc");
  });

  test.each([
    ["OIDC_JWKS_URL", "http://idp.example.com/.well-known/jwks.json"],
    ["OIDC_JWKS_URL", "file:///etc/passwd"],
    ["OIDC_ISSUER", "http://idp.example.com/"],
    ["OIDC_ISSUER", "file:///srv/idp"],
  ])("produção recusa %s com esquema não https (%s)", (name, value) => {
    expect(() => loadConfig({ ...PROD, ...OIDC, [name]: value })).toThrow(name);
  });

  test("produção aceita https em OIDC_JWKS_URL e OIDC_ISSUER", () => {
    expect(loadConfig({ ...PROD, ...OIDC }).auth.mode).toBe("oidc");
  });

  test("fora de produção os defaults continuam aceitos", () => {
    const cfg = loadConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://wagering_app:app@localhost:5432/wagering",
      SQS_ENDPOINT: "http://localhost:4566",
      AWS_ACCESS_KEY_ID: "test",
    });
    expect(cfg.production).toBe(false);
  });
});

describe("detecção de produção fail-safe (B-12)", () => {
  test("NODE_ENV ausente é produção", () => {
    const { NODE_ENV: _omit, ...noEnv } = BASE;
    expect(() => loadConfig(noEnv)).toThrow("AUTH_MODE");
  });

  test.each(["Production", " production ", "PRODUCTION", "prod", "staging", ""])(
    "NODE_ENV=%p é tratado como produção",
    (value) => {
      expect(() => loadConfig({ ...BASE, NODE_ENV: value })).toThrow("AUTH_MODE");
    },
  );

  test.each(["development", "test", " Test ", "DEVELOPMENT"])("NODE_ENV=%p não é produção", (value) => {
    expect(loadConfig({ ...BASE, NODE_ENV: value }).production).toBe(false);
  });

  test("docsEnabled segue a mesma detecção: 'Production' desliga /docs", () => {
    const cfg = loadConfig({ ...BASE, NODE_ENV: "Production", AUTH_MODE: "disabled" });
    expect(cfg.production).toBe(true);
    expect(cfg.docsEnabled).toBe(false);
  });
});

describe("senha do banco em produção (B-11)", () => {
  const PROD_OIDC = { ...BASE, ...OIDC, NODE_ENV: "production" };

  test.each([
    ["senha padrão com percent-encoding", "postgres://wagering_app:%61pp@db:5432/w"],
    ["senha padrão do owner com percent-encoding", "postgres://wagering_owner:%6Fwner@db:5432/w"],
    ["senha postgres com percent-encoding", "postgres://postgres:%70ostgres@db:5432/w"],
    ["senha padrão em ?password=", "postgres://wagering_owner@db:5432/w?password=owner"],
    ["senha padrão com outro usuário", "postgres://admin:postgres@db:5432/w"],
    ["senha padrão em maiúsculas", "postgres://wagering_app:APP@db:5432/w"],
    ["senha owner com outro usuário", "postgres://qualquer:owner@db:5432/w"],
    ["senha curta", "postgres://wagering_app:abc@db:5432/w"],
    ["senha curta em ?password=", "postgres://wagering_app@db:5432/w?password=abc"],
  ])("recusa %s", (_label, url) => {
    expect(() => loadConfig({ ...PROD_OIDC, DATABASE_URL: url })).toThrow("DATABASE_URL");
  });

  test("senha forte de 24 caracteres passa", () => {
    expect(loadConfig({ ...PROD_OIDC, DATABASE_URL: `postgres://wagering_app:${STRONG_PASSWORD}@db:5432/w` }).auth.mode).toBe(
      "oidc",
    );
  });

  test("URL sem senha é aceita (autenticação por outro meio)", () => {
    expect(loadConfig({ ...PROD_OIDC, DATABASE_URL: "postgres://wagering_app@db:5432/w" }).auth.mode).toBe("oidc");
  });
});

describe("chaves AWS em produção (B-13)", () => {
  const PROD_OIDC = { ...BASE, ...OIDC, NODE_ENV: "production" };

  test.each([" test", "TEST", "Test "])("AWS_ACCESS_KEY_ID=%p é recusado", (value) => {
    expect(() => loadConfig({ ...PROD_OIDC, AWS_ACCESS_KEY_ID: value })).toThrow("AWS_ACCESS_KEY_ID");
  });

  test("chave de exemplo da AWS é recusada", () => {
    expect(() => loadConfig({ ...PROD_OIDC, AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE" })).toThrow("AWS_ACCESS_KEY_ID");
  });

  test("AWS_SECRET_ACCESS_KEY=test é recusado", () => {
    expect(() => loadConfig({ ...PROD_OIDC, AWS_ACCESS_KEY_ID: "AKIAREALKEY0001", AWS_SECRET_ACCESS_KEY: " TEST" })).toThrow(
      "AWS_SECRET_ACCESS_KEY",
    );
  });
});
