import { Module } from "@nestjs/common";
import { CLOCK, METRICS, UNIT_OF_WORK } from "../../application/ports/tokens";
import type { Clock } from "../../application/ports/clock";
import { EXCLUSIVE_RUNNER } from "../../application/ports/exclusive-runner";
import { LOGGER, type Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { ReconcileAllWallets } from "../../application/wallet/reconcile-all-wallets";
import { ReconcileWallet } from "../../application/wallet/reconcile-wallet";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { createLogger } from "../../infrastructure/observability/logger";
import { PgAdvisoryLock } from "../../infrastructure/persistence/pg-advisory-lock";
import { ReconciliationWorker } from "./reconciliation.worker";

/**
 * Job periódico de reconciliação. Liga o loop só com o papel `reconciler` em APP_ROLES.
 * Depende das portas globais (UNIT_OF_WORK, CLOCK, METRICS do PersistenceModule).
 */
@Module({
  providers: [
    { provide: LOGGER, useFactory: () => createLogger() },
    {
      provide: EXCLUSIVE_RUNNER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new PgAdvisoryLock(config.databaseUrl),
    },
    {
      provide: ReconcileAllWallets,
      inject: [UNIT_OF_WORK, CLOCK, METRICS, LOGGER],
      useFactory: (uow: UnitOfWork, clock: Clock, metrics: Metrics, logger: Logger) =>
        new ReconcileAllWallets(uow, new ReconcileWallet(uow, logger, metrics), clock, metrics, logger),
    },
    ReconciliationWorker,
  ],
  exports: [ReconcileAllWallets, ReconciliationWorker],
})
export class ReconciliationModule {}
