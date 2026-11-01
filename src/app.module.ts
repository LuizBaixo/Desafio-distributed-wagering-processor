import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { APP_CONFIG, type AppConfig } from "./config/config";
import { ConfigModule } from "./config/config.module";
import { createLogger } from "./infrastructure/observability/logger";
import { PersistenceModule } from "./infrastructure/persistence/persistence.module";
import { CreateWallet } from "./application/wallet/create-wallet";
import { WalletQueries } from "./application/wallet/wallet-queries";
import { ReconcileWallet } from "./application/wallet/reconcile-wallet";
import { LOGGER, type Logger } from "./application/ports/logger";
import { METRICS } from "./application/ports/tokens";
import type { Metrics } from "./application/ports/metrics";
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from "./application/ports/tokens";
import type { Clock } from "./application/ports/clock";
import type { IdGenerator } from "./application/ports/id-generator";
import type { UnitOfWork } from "./application/ports/unit-of-work";
import { HealthController } from "./interfaces/http/health.controller";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";
import { ERROR_LOGGER, HttpErrorFilter } from "./interfaces/http/http-error.filter";
import { WageringModule } from "./interfaces/http/wagering.module";
import { WagerEngine } from "./application/wagering/wager-engine";
import { ReprocessPendingReferences } from "./application/wagering/reprocess-pending-references";
import { PendingReferenceWorker } from "./interfaces/workers/pending-reference.worker";

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
        WageringModule,
      ],
      controllers: [HealthController, MetricsController, WalletsController],
      providers: [
        {
          provide: ReprocessPendingReferences,
          inject: [UNIT_OF_WORK, WagerEngine, CLOCK, ID_GENERATOR, LOGGER, METRICS, APP_CONFIG],
          useFactory: (
            uow: UnitOfWork,
            engine: WagerEngine,
            clock: Clock,
            ids: IdGenerator,
            logger: Logger,
            metrics: Metrics,
            config: AppConfig,
          ) =>
            new ReprocessPendingReferences(uow, engine, clock, ids, logger, metrics, {
              maxAttempts: config.pending.maxAttempts,
            }),
        },
        PendingReferenceWorker,
        {
          provide: CreateWallet,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
        },
        {
          provide: WalletQueries,
          inject: [UNIT_OF_WORK],
          useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
        },
        {
          provide: ReconcileWallet,
          inject: [UNIT_OF_WORK, LOGGER, METRICS],
          useFactory: (uow: UnitOfWork, logger: Logger, metrics: Metrics) =>
            new ReconcileWallet(uow, logger, metrics),
        },
        { provide: LOGGER, useFactory: () => createLogger() },
        { provide: ERROR_LOGGER, useFactory: () => createLogger() },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
