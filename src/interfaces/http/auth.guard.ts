import { Injectable, type CanActivate } from "@nestjs/common";

/** Guard no-op: autenticação fica para o desenho documentado (README §2, Design §12). */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/** Ponto de extensão: valida se a identidade do provedor pode agir como `providerId`. */
export interface ProviderIdentityPort {
  assertCanActAs(providerId: string): void;
}

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  assertCanActAs(_providerId: string): void {
    // no-op por decisão de escopo (ver ARCHITECTURE.md §14, Autenticação)
  }
}
