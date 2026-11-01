import { Module } from "@nestjs/common";
import { CLOCK, ID_GENERATOR, METRICS, UNIT_OF_WORK } from "../../application/ports/tokens";
import type { Clock } from "../../application/ports/clock";
import type { IdGenerator } from "../../application/ports/id-generator";
import type { Metrics } from "../../application/ports/metrics";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { WagerEngine } from "../../application/wagering/wager-engine";
import { WagerQueries } from "../../application/wagering/wager-queries";
import { WageringController } from "./wagering.controller";

/**
 * Casos de uso de aposta e rotas HTTP. As portas (UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS)
 * vêm do PersistenceModule global. Exporta o motor e o caso de uso para o consumer SQS (Tarefa 13)
 * e para o worker de pendentes (Tarefa 12).
 */
@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: WagerEngine,
      inject: [ID_GENERATOR, CLOCK],
      useFactory: (ids: IdGenerator, clock: Clock) => new WagerEngine(ids, clock),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, WagerEngine, ID_GENERATOR, CLOCK, METRICS],
      useFactory: (uow: UnitOfWork, engine: WagerEngine, ids: IdGenerator, clock: Clock, metrics: Metrics) =>
        new SubmitWagerTransaction(uow, engine, ids, clock, metrics),
    },
    {
      provide: WagerQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new WagerQueries(uow),
    },
  ],
  exports: [WagerEngine, SubmitWagerTransaction, WagerQueries],
})
export class WageringModule {}
