import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config/config";
import { setupOpenApi } from "../../src/interfaces/http/openapi";
import { TEST_APP_DATABASE_URL, TEST_SQS_ENDPOINT } from "../helpers/env";

process.env.LOG_LEVEL ??= "silent";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

type Schema = Record<string, unknown>;

interface OpenApiDoc {
  paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string; required?: boolean }>; responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, Schema> };
}

/** Percorre o schema recursivamente e devolve todo objeto que tenha a propriedade `amount`. */
function amountSchemas(node: unknown, found: Schema[] = []): Schema[] {
  if (Array.isArray(node)) {
    for (const item of node) amountSchemas(item, found);
  } else if (node !== null && typeof node === "object") {
    const obj = node as Schema;
    const props = obj.properties as Record<string, Schema> | undefined;
    if (props?.amount) found.push(props.amount);
    for (const value of Object.values(obj)) amountSchemas(value, found);
  }
  return found;
}

describe("OpenAPI em /docs", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: TEST_APP_DATABASE_URL,
      SQS_ENDPOINT: TEST_SQS_ENDPOINT,
      AWS_REGION: "us-east-1",
    });
    app = await NestFactory.create(AppModule.register(config), { logger: false });
    setupOpenApi(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  test("/docs-json responde 200 com JSON OpenAPI", async () => {
    const res = await fetch(`${baseUrl}/docs-json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string };
    expect(doc.openapi).toMatch(/^3\./);
  });

  test("/docs responde a UI HTML", async () => {
    const res = await fetch(`${baseUrl}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("POST /wagering/transactions exige Idempotency-Key e documenta o status 500 FAILED", async () => {
    const doc = (await (await fetch(`${baseUrl}/docs-json`)).json()) as OpenApiDoc;
    const op = doc.paths["/wagering/transactions"]?.post;
    expect(op).toBeDefined();
    if (!op) return;
    const key = op.parameters?.find((p) => p.name === "Idempotency-Key");
    expect(key).toBeDefined();
    expect(key?.in).toBe("header");
    expect(key?.required).toBe(true);
    for (const status of ["200", "202", "400", "409", "422", "500", "503"]) {
      expect(op.responses[status]).toBeDefined();
    }
  });

  test("todo campo amount é string com o padrão de duas casas", async () => {
    const doc = (await (await fetch(`${baseUrl}/docs-json`)).json()) as OpenApiDoc;
    const amounts = amountSchemas(doc.components.schemas);
    expect(amounts.length).toBeGreaterThan(0);
    for (const schema of amounts) {
      expect(schema.type).toBe("string");
      expect(schema.pattern).toBe("^\\d+\\.\\d{2}$");
    }
  });
});
