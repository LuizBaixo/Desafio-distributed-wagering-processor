import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config/config";
import { TEST_APP_DATABASE_URL, TEST_QUEUE_ENV, TEST_SQS_ENDPOINT } from "./env";
import { ensureTestQueues } from "./sqs";

export interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
  /** Contexto Nest, para testes que chamam serviços direto (ex.: `app.get(ReprocessPendingReferences)`). */
  app?: INestApplication;
}

/**
 * Sobe a aplicação Nest in-process em porta aleatória, com a infra de teste.
 * `env` sobrepõe as variáveis padrão (ex.: `{ DATABASE_URL: "...:5999/..." }`).
 */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  process.env.LOG_LEVEL ??= "silent";
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  await ensureTestQueues();

  const config = loadConfig({
    DATABASE_URL: TEST_APP_DATABASE_URL,
    SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    AWS_REGION: "us-east-1",
    ...TEST_QUEUE_ENV,
    ...env,
  });
  const app: INestApplication = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.listen(0, "127.0.0.1");
  return {
    baseUrl: await app.getUrl(),
    close: () => app.close(),
    app,
  };
}
