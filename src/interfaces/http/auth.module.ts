import { Global, Inject, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";
import type { Logger } from "../../application/ports/logger";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { OidcTokenVerifier } from "../../infrastructure/auth/oidc-token-verifier";
import { TOKEN_VERIFIER } from "../../infrastructure/auth/principal";
import { createLogger } from "../../infrastructure/observability/logger";
import { AuthGuard, ClaimsProviderIdentity, NoopProviderIdentity, PROVIDER_IDENTITY } from "./auth.guard";

const AUTH_LOGGER = Symbol("AUTH_LOGGER");

class AuthStartupWarning implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (this.config.production && this.config.auth.mode === "disabled") {
      this.logger.warn({ authMode: "disabled" }, "AUTH_MODE=disabled in production: every HTTP route is open to any caller");
    }
  }
}

/** Escolhe o verificador de token e a identidade de provedor conforme `AUTH_MODE`. */
@Global()
@Module({})
export class AuthModule {
  static register(): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        {
          provide: TOKEN_VERIFIER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => (config.auth.mode === "oidc" ? new OidcTokenVerifier(config.auth) : null),
        },
        {
          provide: PROVIDER_IDENTITY,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) =>
            config.auth.mode === "oidc" ? new ClaimsProviderIdentity() : new NoopProviderIdentity(),
        },
        { provide: AUTH_LOGGER, useFactory: () => createLogger() },
        AuthStartupWarning,
        AuthGuard,
      ],
      exports: [TOKEN_VERIFIER, PROVIDER_IDENTITY, AuthGuard],
    };
  }
}
