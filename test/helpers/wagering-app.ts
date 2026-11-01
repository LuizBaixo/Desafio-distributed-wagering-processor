import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config/config";
import { WageringModule } from "../../src/interfaces/http/wagering.module";
import { TEST_APP_DATABASE_URL, TEST_SQS_ENDPOINT } from "./env";
import type { TestApp } from "./http";

/**
 * Sobe a app com o WageringModule montado ao lado do AppModule. Provisório: quando o AppModule
 * importar o WageringModule, `startTestApp` basta e este helper some.
 */
export async function startWageringTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  process.env.LOG_LEVEL ??= "silent";
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  const config = loadConfig({
    DATABASE_URL: TEST_APP_DATABASE_URL,
    SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    AWS_REGION: "us-east-1",
    ...env,
  });

  @Module({ imports: [AppModule.register(config), WageringModule] })
  class TestRootModule {}

  const app: INestApplication = await NestFactory.create(TestRootModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  return { baseUrl: await app.getUrl(), close: () => app.close() };
}
