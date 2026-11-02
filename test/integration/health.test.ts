import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import {
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type INestApplication,
} from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { loadConfig, type AppConfig } from "../../src/config/config";
import { TEST_APP_DATABASE_URL, TEST_SQS_ENDPOINT } from "../helpers/env";

/**
 * Só de teste: simula trabalho em andamento no shutdown (como o consumidor ou o worker, sem depender do SQS).
 * Fica no módulo raiz do teste, que o Nest executa depois dos módulos importados (AppModule).
 */
const SHUTDOWN_WAIT_MS = 1500;

@Injectable()
class SlowShutdownProbe implements BeforeApplicationShutdown {
  async beforeApplicationShutdown(): Promise<void> {
    await Bun.sleep(SHUTDOWN_WAIT_MS);
  }
}

@Module({})
class ShutdownProbeRoot {
  static register(config: AppConfig): DynamicModule {
    return { module: ShutdownProbeRoot, imports: [AppModule.register(config)], providers: [SlowShutdownProbe] };
  }
}

process.env.LOG_LEVEL ??= "silent";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

async function startApp(databaseUrl: string): Promise<{ app: INestApplication; baseUrl: string }> {
  const config = loadConfig({
      NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    AWS_REGION: "us-east-1",
  });
  const app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.listen(0, "127.0.0.1");
  return { app, baseUrl: await app.getUrl() };
}

describe("health e metrics", () => {
  let healthy: { app: INestApplication; baseUrl: string };
  let broken: { app: INestApplication; baseUrl: string };

  beforeAll(async () => {
    healthy = await startApp(TEST_APP_DATABASE_URL);
    // Porta 5999 não tem Postgres: readiness deve falhar com 503.
    broken = await startApp("postgres://wagering_app:app@localhost:5999/wagering");
  });

  afterAll(async () => {
    await healthy?.app.close();
    await broken?.app.close();
  });

  test("GET /health/live responde 200 {status:'ok'}", async () => {
    const res = await fetch(`${healthy.baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready responde 200 com PostgreSQL e SQS no ar", async () => {
    const res = await fetch(`${healthy.baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready responde 503 quando o banco está na porta 5999", async () => {
    const res = await fetch(`${broken.baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({ error: { code: "INFRA_UNAVAILABLE", message: "service unavailable" } });
    expect(JSON.stringify(body)).not.toMatch(/db=|sqs=/);
  });

  test("readiness com falha registra o detalhe (db=down sqs=ok) em warn, no log", async () => {
    const warn = spyOn(Logger.prototype, "warn");
    try {
      const res = await fetch(`${broken.baseUrl}/health/ready`);
      expect(res.status).toBe(503);
      const messages = warn.mock.calls.map((args) => String(args[0]));
      expect(messages).toContain("not ready: db=down sqs=ok");
    } finally {
      warn.mockRestore();
    }
  });

  test("GET /metrics no formato Prometheus contém wager_transactions_total", async () => {
    const res = await fetch(`${healthy.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("wager_transactions_total");
  });
});

describe("readiness durante o shutdown", () => {
  test("app.close() em andamento: /health/ready 503 SHUTTING_DOWN e /health/live 200 em menos de 200 ms", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: TEST_APP_DATABASE_URL,
      SQS_ENDPOINT: TEST_SQS_ENDPOINT,
      AWS_REGION: "us-east-1",
    });
    const app = await NestFactory.create(ShutdownProbeRoot.register(config), { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();

    // Sem await: o shutdown fica parado no SlowShutdownProbe, antes de o servidor HTTP fechar.
    const closing = app.close();
    const started = Date.now();
    // O estado vira "desligando" no primeiro onModuleDestroy, alguns ticks depois de close(). Consulta até ver.
    let ready = await fetch(`${baseUrl}/health/ready`);
    let body = (await ready.json()) as { error?: { code: string } };
    while (body.error?.code !== "SHUTTING_DOWN" && Date.now() - started < 200) {
      ready = await fetch(`${baseUrl}/health/ready`);
      body = (await ready.json()) as { error?: { code: string } };
    }
    const live = await fetch(`${baseUrl}/health/live`);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(200);
    expect(ready.status).toBe(503);
    expect(body.error?.code).toBe("SHUTTING_DOWN");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });

    await closing;
  });
});
