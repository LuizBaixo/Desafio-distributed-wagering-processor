import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { DynamicModule, OnApplicationShutdown } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/config";
import { setupOpenApi } from "./interfaces/http/openapi";

/** Limite do body JSON. Acima disso, `payloadTooLarge` responde 413. */
const JSON_BODY_LIMIT = "64kb";

/**
 * Cabeçalhos de segurança em todas as respostas. Em `/docs` o CSP sai, porque o Swagger UI usa script inline.
 */
const strictHeaders = helmet();
const docsHeaders = helmet({ contentSecurityPolicy: false });

function securityHeaders(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
  (req.url?.startsWith("/docs") ? docsHeaders : strictHeaders)(req, res, next);
}

/**
 * Erro de body acima do limite. O body-parser responderia HTML; aqui sai no formato `{ error: { code, message } }`.
 * Registrado depois das rotas (ver `bootstrap`), para receber os erros do parser.
 */
function payloadTooLarge(
  err: unknown,
  _req: IncomingMessage,
  res: { status(code: number): { json(body: unknown): void } },
  next: (err?: unknown) => void,
): void {
  if ((err as { type?: string } | null)?.type === "entity.too.large") {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "payload too large" } });
    return;
  }
  next(err);
}

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
  // bodyParser: false, para o parser e o handler de 413 entrarem antes do init. Assim ficam antes
  // do handler de erro que o Nest registra no init, e o 413 não vira 500.
  const app = await NestFactory.create<NestExpressApplication>(
    tracingShutdown ? withTracingFlush(root, tracingShutdown) : root,
    { bufferLogs: true, bodyParser: false },
  );
  app.useLogger(app.get(Logger));
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  app.use(payloadTooLarge);
  // /docs só com DOCS_ENABLED (padrão: ligado fora de production).
  if (config.docsEnabled) setupOpenApi(app);
  // useProcessExit: depois dos hooks, sai com 0 (e dá flush no pino) em vez de reenviar o sinal
  // ao próprio processo, o que terminaria com 143 e pareceria um shutdown abortado.
  app.enableShutdownHooks(undefined, { useProcessExit: true });
  await app.listen(config.port, "0.0.0.0");
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
