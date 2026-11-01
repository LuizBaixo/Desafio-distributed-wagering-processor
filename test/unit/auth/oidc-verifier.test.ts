import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OidcTokenVerifier } from "../../../src/infrastructure/auth/oidc-token-verifier";
import { TEST_AUDIENCE, TEST_ISSUER, startTestIdp, type TestIdp } from "../../helpers/oidc";

let idp: TestIdp;
let verifier: OidcTokenVerifier;

beforeAll(async () => {
  idp = await startTestIdp();
  verifier = new OidcTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwksUrl: idp.jwksUrl });
});
afterAll(async () => {
  await idp.stop();
});

describe("OidcTokenVerifier", () => {
  test("token válido devolve providerId e scopes", async () => {
    const token = await idp.sign({ provider_id: "provider-a", scope: "openid wallet:admin" });
    expect(await verifier.verify(token)).toEqual({ providerId: "provider-a", scopes: ["openid", "wallet:admin"] });
  });

  test("sem provider_id nem scope, principal vazio", async () => {
    expect(await verifier.verify(await idp.sign())).toEqual({ providerId: undefined, scopes: [] });
  });

  test("provider_id que não é string é ignorado", async () => {
    const principal = await verifier.verify(await idp.sign({ provider_id: 42 }));
    expect(principal.providerId).toBeUndefined();
  });

  test("token expirado é rejeitado", async () => {
    await expect(verifier.verify(await idp.sign({}, { expiresIn: -60 }))).rejects.toThrow();
  });

  test("issuer errado é rejeitado", async () => {
    await expect(verifier.verify(await idp.sign({}, { issuer: "https://evil/" }))).rejects.toThrow();
  });

  test("audience errada é rejeitada", async () => {
    await expect(verifier.verify(await idp.sign({}, { audience: "outra" }))).rejects.toThrow();
  });

  test("assinatura de outra chave é rejeitada", async () => {
    await expect(verifier.verify(await idp.sign({}, { key: "other" }))).rejects.toThrow();
  });

  test("alg none e lixo são rejeitados", async () => {
    const none = `${btoa('{"alg":"none"}')}.${btoa('{"iss":"x"}')}.`;
    await expect(verifier.verify(none)).rejects.toThrow();
    await expect(verifier.verify("lixo")).rejects.toThrow();
  });
});
