import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "./config/config";
import { ConfigModule } from "./config/config.module";
import { createLogger } from "./infrastructure/observability/logger";
import { PersistenceModule } from "./infrastructure/persistence/persistence.module";
import { HealthController } from "./interfaces/http/health.controller";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { ERROR_LOGGER, HttpErrorFilter } from "./interfaces/http/http-error.filter";

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: { logger: createLogger(), autoLogging: false },
        }),
        ConfigModule.register(config),
        PersistenceModule,
      ],
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: ERROR_LOGGER, useFactory: () => createLogger() },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
