import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { DynamicModule, OnApplicationShutdown } from "@nestjs/common";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/config";
import { setupOpenApi } from "./interfaces/http/openapi";

/** Faz o flush dos spans finais no shutdown da aplicação (ver `withTracingFlush`). */
class TracingFlush implements OnApplicationShutdown {
  constructor(private readonly flush: () => Promise<void>) {}

  onApplicationShutdown(): Promise<void> {
    return this.flush();
  }
}

/** Registra `TracingFlush` no módulo raiz; o Nest o chama em `onApplicationShutdown` (hooks de shutdown ativos). */
function withTracingFlush(root: DynamicModule, flush: () => Promise<void>): DynamicModule {
  return { ...root, providers: [...(root.providers ?? []), { provide: TracingFlush, useValue: new TracingFlush(flush) }] };
}

async function bootstrap(): Promise<void> {
  // Tracing opcional: sem o endpoint, nenhum pacote do OpenTelemetry é carregado.
  let tracingShutdown: (() => Promise<void>) | undefined;
  if (process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) {
    const { initTracing } = await import("./infrastructure/observability/tracing");
    tracingShutdown = (await initTracing()).shutdown;
  }
  const config = loadConfig();
  const root = AppModule.register(config);
  const app = await NestFactory.create(tracingShutdown ? withTracingFlush(root, tracingShutdown) : root, { bufferLogs: true });
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
