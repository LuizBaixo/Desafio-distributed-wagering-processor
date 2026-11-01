import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ForbiddenError, TransientInfrastructureError, UnauthorizedError } from "../../application/errors";
import { TOKEN_VERIFIER, type Principal, type TokenVerifier } from "../../infrastructure/auth/principal";

const REQUIRED_SCOPE = "auth:required-scope";

/** Exige que o token traga o scope; sem ele, 403 `FORBIDDEN_SCOPE`. */
export const RequireScope = (scope: string): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_SCOPE, scope);

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  principal?: Principal;
}

/**
 * Autenticação por bearer token. Com `AUTH_MODE=disabled` (verificador nulo) tudo passa e nenhum
 * principal é anexado; com `oidc`, token ausente ou inválido vira 401 e o principal fica em `req.principal`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier | null,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.verifier === null) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers["authorization"];
    const match = typeof header === "string" ? /^Bearer (\S+)$/i.exec(header) : null;
    if (!match) throw new UnauthorizedError();

    let principal: Principal;
    try {
      principal = await this.verifier.verify(match[1]!);
    } catch (err) {
      // IdP indisponível: 503 (o filtro mapeia para INFRA_UNAVAILABLE + Retry-After), não 401.
      if (err instanceof TransientInfrastructureError) throw err;
      // O motivo (expirado, issuer, assinatura) não vai ao cliente.
      throw new UnauthorizedError();
    }
    req.principal = principal;

    const scope = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_SCOPE, [ctx.getHandler(), ctx.getClass()]);
    if (scope !== undefined && !principal.scopes.includes(scope)) {
      throw new ForbiddenError(`scope ${scope} is required`, "FORBIDDEN_SCOPE");
    }
    return true;
  }
}

/** Principal validado pelo guard; `undefined` com `AUTH_MODE=disabled`. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined => ctx.switchToHttp().getRequest<AuthedRequest>().principal,
);

/** Decide se a identidade pode agir como `providerId` (o provedor do token, ou qualquer um com auth desligada). */
export interface ProviderIdentityPort {
  /** Lança `ForbiddenError` (`PROVIDER_MISMATCH`) se não puder. */
  assertCanActAs(principal: Principal | undefined, providerId: string): void;
  canActAs(principal: Principal | undefined, providerId: string): boolean;
}

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

/** `AUTH_MODE=disabled`: sem identidade, qualquer provedor é aceito. */
@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  assertCanActAs(): void {}

  canActAs(): boolean {
    return true;
  }
}

/** `AUTH_MODE=oidc`: o `providerId` pedido precisa ser igual ao claim `provider_id` do token. */
@Injectable()
export class ClaimsProviderIdentity implements ProviderIdentityPort {
  canActAs(principal: Principal | undefined, providerId: string): boolean {
    return principal?.providerId !== undefined && principal.providerId === providerId;
  }

  assertCanActAs(principal: Principal | undefined, providerId: string): void {
    if (!this.canActAs(principal, providerId)) {
      throw new ForbiddenError("token provider_id does not match the requested provider", "PROVIDER_MISMATCH");
    }
  }
}
