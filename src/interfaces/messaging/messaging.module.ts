import { Global, Module } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock";
import type { IdGenerator } from "../../application/ports/id-generator";
import type { Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import { CLOCK, ID_GENERATOR, METRICS, UNIT_OF_WORK } from "../../application/ports/tokens";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { RecordPermanentFailure } from "../../application/wagering/record-permanent-failure";
import { WagerEngine } from "../../application/wagering/wager-engine";
import { LOGGER } from "../../application/ports/logger";
import { QUEUE_PORT } from "../../application/ports/queue";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { createLogger } from "../../infrastructure/observability/logger";
import { SqsQueue } from "../../infrastructure/sqs/sqs-queue";
import { FAULT_INJECTION, FaultInjection } from "../../infrastructure/system/fault-injection";
import { WageringModule } from "../http/wagering.module";
import { WagerConsumer } from "./wager-consumer";

/**
 * Fila SQS e consumidor de apostas. Global porque o /health/ready (módulo raiz) usa o QUEUE_PORT.
 * O consumidor só liga com o papel `consumer` em APP_ROLES. Depende do WageringModule
 * (SubmitWagerTransaction), que deve estar na árvore do AppModule.
 */
@Global()
@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: QUEUE_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SqsQueue({
          endpoint: config.sqsEndpoint,
          region: config.awsRegion,
          pingQueue: config.queues.wager,
          visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
        }),
    },
    { provide: LOGGER, useFactory: () => createLogger() },
    { provide: FAULT_INJECTION, useFactory: () => new FaultInjection() },
    {
      provide: RecordPermanentFailure,
      inject: [UNIT_OF_WORK, WagerEngine, ID_GENERATOR, CLOCK, METRICS, LOGGER],
      useFactory: (
        uow: UnitOfWork,
        engine: WagerEngine,
        ids: IdGenerator,
        clock: Clock,
        metrics: Metrics,
        logger: Logger,
      ) => new RecordPermanentFailure(uow, engine, ids, clock, metrics, logger),
    },
    WagerConsumer,
  ],
  exports: [QUEUE_PORT, RecordPermanentFailure],
})
export class MessagingModule {}
