import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { APP_CONFIG, type AppConfig } from "./config/config";
import { METRICS } from "./application/ports/metrics";
import { PromMetrics } from "./infrastructure/observability/prom-metrics";
import { createLogger } from "./infrastructure/observability/logger";
import { HealthController } from "./interfaces/http/health.controller";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { HttpErrorFilter } from "./interfaces/http/http-error.filter";

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: { logger: createLogger(), autoLogging: false },
        }),
      ],
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        PromMetrics,
        { provide: METRICS, useExisting: PromMetrics },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
