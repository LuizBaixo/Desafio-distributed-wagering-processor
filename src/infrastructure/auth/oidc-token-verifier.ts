import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { TransientInfrastructureError } from "../../application/errors";
import type { Principal, TokenVerifier } from "./principal";

export interface OidcOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** Timeout de cada busca do JWKS ao IdP (`OIDC_JWKS_TIMEOUT_MS`). */
  jwksTimeoutMs?: number;
}

/** Timeout padrão de cada busca do JWKS, em ms. */
export const DEFAULT_JWKS_TIMEOUT_MS = 2000;

/**
 * Valida JWT emitido por um IdP OIDC: assinatura pelo JWKS remoto (com cache e refresh do `jose`),
 * issuer, audience, exp (obrigatório) e algoritmo (apenas RS256 e ES256, o que bloqueia `none` e HS256).
 *
 * Falha de infraestrutura (IdP fora, timeout, resposta não-200, JWKS inválido) vira
 * `TransientInfrastructureError` (503). Token inválido (inclusive kid desconhecido) vira erro comum (401).
 * Fail-closed: nenhuma falha deixa o token passar.
 */
export class OidcTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey;

  constructor(private readonly opts: OidcOptions) {
    const remote = createRemoteJWKSet(new URL(opts.jwksUrl), {
      timeoutDuration: opts.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
    });
    this.jwks = async (protectedHeader, token) => {
      try {
        return await remote(protectedHeader, token);
      } catch (err) {
        // Chave ausente no JWKS é problema do token; qualquer outra falha é do IdP.
        if (err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWKSMultipleMatchingKeys) {
          throw err;
        }
        throw new TransientInfrastructureError("identity provider unavailable");
      }
    };
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["exp"],
    });
    const providerId = typeof payload["provider_id"] === "string" ? payload["provider_id"] : undefined;
    const scope = typeof payload["scope"] === "string" ? payload["scope"] : "";
    return { providerId, scopes: scope.split(" ").filter((s) => s.length > 0) };
  }
}
