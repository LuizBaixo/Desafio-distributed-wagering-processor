import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/config";
import { setupOpenApi } from "./interfaces/http/openapi";

async function bootstrap(): Promise<void> {
  // Tracing opcional: sem o endpoint, nenhum pacote do OpenTelemetry é carregado.
  if (process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) {
    const { initTracing } = await import("./infrastructure/observability/tracing");
    await initTracing();
  }
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  setupOpenApi(app);
  // useProcessExit: depois dos hooks, sai com 0 (e dá flush no pino) em vez de reenviar o sinal
  // ao próprio processo, o que terminaria com 143 e pareceria um shutdown abortado.
  app.enableShutdownHooks(undefined, { useProcessExit: true });
  await app.listen(config.port, "0.0.0.0");
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
