import { Controller, Get, Inject, Res, type OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { TransientInfrastructureError } from "../../application/errors";
import { QUEUE_PORT, type QueuePort } from "../../application/ports/queue";
import { LifecycleState } from "../../infrastructure/system/lifecycle-state";

/** Subconjunto de Express Response usado aqui; evita depender de @types/express. */
interface ResponseLike {
  status(code: number): unknown;
}

/**
 * Liveness: processo vivo. Readiness: SELECT 1 no PostgreSQL e `QueuePort.ping()` no SQS.
 * Durante o shutdown, readiness responde 503 SHUTTING_DOWN, e liveness segue 200 até o fim.
 */
@Controller("health")
export class HealthController implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(LifecycleState) private readonly lifecycle: LifecycleState,
  ) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    // Sem listener, o erro de uma conexão ociosa (Postgres reiniciou) derruba o processo.
    // O próximo ping abre outra conexão e reporta o estado real.
    this.pool.on("error", () => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: ResponseLike): Promise<{ status: string } | { error: { code: string; message: string } }> {
    if (this.lifecycle.isShuttingDown()) {
      res.status(503);
      return { error: { code: "SHUTTING_DOWN", message: "shutting down" } };
    }
    const db = await this.pingDb();
    const sqs = await this.pingSqs();
    if (db !== "ok" || sqs !== "ok") {
      throw new TransientInfrastructureError(`not ready: db=${db} sqs=${sqs}`);
    }
    return { status: "ok" };
  }

  private async pingDb(): Promise<"ok" | "down"> {
    try {
      await this.pool.query("SELECT 1");
      return "ok";
    } catch {
      return "down";
    }
  }

  private async pingSqs(): Promise<"ok" | "down"> {
    try {
      await this.queue.ping();
      return "ok";
    } catch {
      return "down";
    }
  }
}
