/** Identidade extraída de um token validado. */
export interface Principal {
  /** Claim `provider_id`: o provedor em nome de quem o chamador age. */
  providerId: string | undefined;
  /** Claim `scope` separada por espaços (ex.: `wallet:admin`). */
  scopes: string[];
}

export interface TokenVerifier {
  /** Lança se o token for inválido, expirado ou de outro emissor/audiência. */
  verify(token: string): Promise<Principal>;
}

/** `null` quando `AUTH_MODE=disabled`. */
export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");

export const ADMIN_SCOPE = "wallet:admin";
