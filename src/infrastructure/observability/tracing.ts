import { context, propagation, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NOOP_TRACING, setTracing, type SpanHandle, type Tracing } from "../../application/ports/tracing";

/**
 * Adaptador OpenTelemetry da porta `Tracing`. Este módulo só é carregado (import dinâmico em `main.ts`)
 * quando `OTEL_EXPORTER_OTLP_ENDPOINT` está definido; sem a variável, nenhum pacote do OpenTelemetry entra
 * no processo. Sem auto-instrumentação: os spans são manuais.
 */
class OtelTracing implements Tracing {
  private readonly tracer = trace.getTracer("wagering-processor");

  async withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: SpanHandle) => Promise<T>,
    options?: { parentTraceparent?: string },
  ): Promise<T> {
    const parent =
      options?.parentTraceparent !== undefined
        ? propagation.extract(context.active(), { traceparent: options.parentTraceparent })
        : context.active();
    return this.tracer.startActiveSpan(name, { attributes }, parent, async (span: Span) => {
      try {
        return await fn({ setAttribute: (k, v) => void span.setAttribute(k, v) });
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.name : "error" });
        throw e;
      } finally {
        span.end();
      }
    });
  }

  currentTraceparent(): string | undefined {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier["traceparent"];
  }
}

/** Teto do flush no shutdown (espera do exporter OTLP). */
export const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface TracingOptions {
  serviceName?: string;
  /** Sobrepõe o exporter OTLP (usado nos testes, com um exporter em memória). */
  spanProcessors?: SpanProcessor[];
}

/** Sobe o SDK e liga `OtelTracing` à porta. O endpoint vem de `OTEL_EXPORTER_OTLP_ENDPOINT` (lido pelo exporter). */
export async function initTracing(options: TracingOptions = {}): Promise<{ shutdown(): Promise<void> }> {
  const [{ NodeSDK }, { OTLPTraceExporter }, { resourceFromAttributes }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ "service.name": options.serviceName ?? process.env["OTEL_SERVICE_NAME"] ?? "wagering-processor" }),
    ...(options.spanProcessors ? { spanProcessors: options.spanProcessors } : { traceExporter: new OTLPTraceExporter() }),
  });
  sdk.start();
  setTracing(new OtelTracing());
  return {
    shutdown: async () => {
      setTracing(NOOP_TRACING);
      // Flush dos spans finais, com teto: um exporter preso não pode atrasar o encerramento.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      });
      try {
        await Promise.race([sdk.shutdown().catch(() => undefined), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
