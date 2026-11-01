import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

export const TEST_ISSUER = "https://idp.test/";
export const TEST_AUDIENCE = "wagering-api";

export interface TestIdp {
  jwksUrl: string;
  /** Assina um JWT RS256 válido por padrão; `claims` e `opts` permitem montar casos inválidos. */
  sign(claims?: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expiresIn?: string | number; key?: "main" | "other" }): Promise<string>;
  stop(): Promise<void>;
}

/** Gera um par RS256 dentro do teste e serve o JWKS num Bun.serve local. */
export async function startTestIdp(): Promise<TestIdp> {
  const main = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(main.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ keys: [jwk] }),
  });
  return {
    jwksUrl: `http://127.0.0.1:${server.port}/jwks.json`,
    async sign(claims = {}, opts = {}) {
      const key = opts.key === "other" ? other.privateKey : main.privateKey;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(opts.issuer ?? TEST_ISSUER)
        .setAudience(opts.audience ?? TEST_AUDIENCE)
        .setSubject("tester")
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? "5m")
        .sign(key);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
