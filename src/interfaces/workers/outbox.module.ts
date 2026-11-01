import { Module } from "@nestjs/common";
import { CLOCK, METRICS, UNIT_OF_WORK } from "../../application/ports/tokens";
import type { Clock } from "../../application/ports/clock";
import { LOGGER, type Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import { QUEUE_PORT, type QueuePort } from "../../application/ports/queue";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { createLogger } from "../../infrastructure/observability/logger";
import { OutboxPublisher } from "./outbox-publisher";

/**
 * Publicador da outbox. Liga o loop só com o papel `outbox` em APP_ROLES.
 * Depende das portas globais (UNIT_OF_WORK, CLOCK, METRICS do PersistenceModule; QUEUE_PORT do MessagingModule).
 */
@Module({
  providers: [
    { provide: LOGGER, useFactory: () => createLogger() },
    {
      provide: OutboxPublisher,
      inject: [UNIT_OF_WORK, QUEUE_PORT, CLOCK, METRICS, LOGGER, APP_CONFIG],
      useFactory: (
        uow: UnitOfWork,
        queue: QueuePort,
        clock: Clock,
        metrics: Metrics,
        logger: Logger,
        config: AppConfig,
      ) =>
        new OutboxPublisher(uow, queue, clock, metrics, logger, {
          queueName: config.queues.events,
          pollMs: config.outbox.pollMs,
          enabled: config.roles.has("outbox"),
          batchSize: config.outbox.batchSize,
          sendBatchSize: config.outbox.sendBatch,
          maxAttempts: config.outbox.maxAttempts,
        }),
    },
  ],
  exports: [OutboxPublisher],
})
export class OutboxModule {}
