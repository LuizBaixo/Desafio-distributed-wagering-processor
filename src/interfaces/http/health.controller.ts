import { Controller, Get, Inject, type OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { TransientInfrastructureError } from "../../application/errors";
import { QUEUE_PORT, type QueuePort } from "../../application/ports/queue";

/**
 * Liveness: processo vivo. Readiness: SELECT 1 no PostgreSQL e `QueuePort.ping()` no SQS.
 */
@Controller("health")
export class HealthController implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: string }> {
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
