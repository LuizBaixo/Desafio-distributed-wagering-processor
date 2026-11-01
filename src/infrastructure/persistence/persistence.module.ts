import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { buildMikroOrmConfig } from "../../../mikro-orm.config";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { CLOCK, ID_GENERATOR, METRICS, UNIT_OF_WORK } from "../../application/ports/tokens";
import { PromMetrics } from "../observability/prom-metrics";
import { SystemClock } from "../system/clock";
import { Uuid7Generator } from "../system/uuid-generator";
import { MikroUnitOfWork } from "./mikro-unit-of-work";
// Registra o parser de NUMERIC como string (efeito colateral intencional).
import "./money.type";

export const MIKRO_ORM = Symbol("MIKRO_ORM");

/** Fecha o MikroORM ao desligar o módulo (SIGTERM com enableShutdownHooks). */
class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  // onApplicationShutdown roda depois de todos os beforeApplicationShutdown: consumidores e workers
  // ainda precisam do banco enquanto terminam o trabalho em andamento.
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

/**
 * Persistência e portas de sistema. Global: qualquer módulo injeta UNIT_OF_WORK, CLOCK,
 * ID_GENERATOR e METRICS pelos tokens de application/ports/tokens.ts.
 * `connect: false`: a aplicação sobe mesmo com o banco fora; /health/ready reporta a falta.
 */
@Global()
@Module({
  providers: [
    {
      provide: MIKRO_ORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        MikroORM.init({ ...buildMikroOrmConfig(config.databaseUrl), connect: false }),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [MIKRO_ORM],
      useFactory: (orm: MikroORM) => new MikroUnitOfWork(orm.em),
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: Uuid7Generator },
    PromMetrics,
    { provide: METRICS, useExisting: PromMetrics },
    OrmLifecycle,
  ],
  exports: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS, PromMetrics],
})
export class PersistenceModule {}
