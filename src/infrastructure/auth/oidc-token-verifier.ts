import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Principal, TokenVerifier } from "./principal";

export interface OidcOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

/**
 * Valida JWT emitido por um IdP OIDC: assinatura pelo JWKS remoto (com cache e refresh do `jose`),
 * issuer, audience, exp e algoritmo (apenas RS256 e ES256, o que bloqueia `none` e HS256).
 */
export class OidcTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey;

  constructor(private readonly opts: OidcOptions) {
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      algorithms: ["RS256", "ES256"],
    });
    const providerId = typeof payload["provider_id"] === "string" ? payload["provider_id"] : undefined;
    const scope = typeof payload["scope"] === "string" ? payload["scope"] : "";
    return { providerId, scopes: scope.split(" ").filter((s) => s.length > 0) };
  }
}
