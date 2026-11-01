import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config/config";
import { TEST_APP_DATABASE_URL, TEST_SQS_ENDPOINT } from "../helpers/env";

process.env.LOG_LEVEL ??= "silent";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

async function startApp(databaseUrl: string): Promise<{ app: INestApplication; baseUrl: string }> {
  const config = loadConfig({
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
    expect(body.error.code).toBe("INFRA_UNAVAILABLE");
    expect(body.error.message).toContain("db=down");
  });

  test("GET /metrics no formato Prometheus contém wager_transactions_total", async () => {
    const res = await fetch(`${healthy.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("wager_transactions_total");
  });
});
