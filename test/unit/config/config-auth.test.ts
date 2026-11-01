import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/config/config";

const BASE = {
  DATABASE_URL: "postgres://wagering_app:s3cr3t-Xk29@db.internal:5432/wagering",
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
      DATABASE_URL: "postgres://wagering_app:app@localhost:5432/wagering",
      SQS_ENDPOINT: "http://localhost:4566",
      AWS_ACCESS_KEY_ID: "test",
    });
    expect(cfg.production).toBe(false);
  });
});
