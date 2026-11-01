import type { MikroORM } from "@mikro-orm/postgresql";
import { SubmitWagerTransaction } from "../../src/application/wagering/submit-wager-transaction";
import { WagerEngine } from "../../src/application/wagering/wager-engine";
import { WagerQueries } from "../../src/application/wagering/wager-queries";
import type { Logger } from "../../src/application/ports/logger";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work";
import { PromMetrics } from "../../src/infrastructure/observability/prom-metrics";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { SystemClock } from "../../src/infrastructure/system/clock";
import { Uuid7Generator } from "../../src/infrastructure/system/uuid-generator";
import { createAppOrm } from "./db";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface WagerHarness {
  orm: MikroORM;
  uow: UnitOfWork;
  metrics: PromMetrics;
  submit: SubmitWagerTransaction;
  queries: WagerQueries;
  close(): Promise<void>;
}

/** Monta o caso de uso sobre a UnitOfWork real (PostgreSQL de teste, papel `wagering_app`). */
export async function buildWagerHarness(
  wrapUow?: (uow: UnitOfWork) => UnitOfWork,
  opts: { lockTimeout?: string; logger?: Logger } = {},
): Promise<WagerHarness> {
  const orm = await createAppOrm();
  const base = new MikroUnitOfWork(orm.em, opts.lockTimeout);
  const uow = wrapUow ? wrapUow(base) : base;
  const ids = new Uuid7Generator();
  const clock = new SystemClock();
  const metrics = new PromMetrics();
  const engine = new WagerEngine(ids, clock);
  return {
    orm,
    uow,
    metrics,
    submit: new SubmitWagerTransaction(uow, engine, ids, clock, metrics, opts.logger ?? silentLogger),
    queries: new WagerQueries(uow),
    close: () => orm.close(true),
  };
}
