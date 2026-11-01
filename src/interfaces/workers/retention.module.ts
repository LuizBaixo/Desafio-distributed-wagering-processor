import { Module } from "@nestjs/common";
import { CLOCK, UNIT_OF_WORK } from "../../application/ports/tokens";
import type { Clock } from "../../application/ports/clock";
import { EXCLUSIVE_RUNNER } from "../../application/ports/exclusive-runner";
import { LOGGER, type Logger } from "../../application/ports/logger";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { PurgeMessagingTables } from "../../application/messaging/purge-messaging-tables";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { createLogger } from "../../infrastructure/observability/logger";
import { PgAdvisoryLock } from "../../infrastructure/persistence/pg-advisory-lock";
import { RetentionWorker } from "./retention.worker";

/**
 * Retenção de outbox publicada e inbox antiga. Liga o loop só com o papel `retention` em APP_ROLES.
 * Depende das portas globais (UNIT_OF_WORK, CLOCK do PersistenceModule).
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
      provide: PurgeMessagingTables,
      inject: [UNIT_OF_WORK, CLOCK, LOGGER],
      useFactory: (uow: UnitOfWork, clock: Clock, logger: Logger) => new PurgeMessagingTables(uow, clock, logger),
    },
    RetentionWorker,
  ],
  exports: [PurgeMessagingTables, RetentionWorker],
})
export class RetentionModule {}
