export type SpanAttributeValue = string | number | boolean;

export interface SpanHandle {
  setAttribute(key: string, value: SpanAttributeValue): void;
}

export interface WithSpanOptions {
  /** `traceparent` W3C de um produtor remoto (por exemplo, atributo da mensagem SQS). Vira o pai do span. */
  parentTraceparent?: string;
}

/**
 * Porta de tracing. Sem `OTEL_EXPORTER_OTLP_ENDPOINT` vale `NOOP_TRACING`: nada do OpenTelemetry é carregado.
 * Nenhum atributo de span pode carregar valor monetário.
 */
export interface Tracing {
  /** Roda `fn` dentro de um span ativo; o span termina quando `fn` resolve ou rejeita (erro vira status ERROR). */
  withSpan<T>(
    name: string,
    attributes: Record<string, SpanAttributeValue>,
    fn: (span: SpanHandle) => Promise<T>,
    options?: WithSpanOptions,
  ): Promise<T>;
  /** `traceparent` do span ativo, ou `undefined` se não há span ativo. */
  currentTraceparent(): string | undefined;
}

const NOOP_SPAN: SpanHandle = { setAttribute() {} };

export const NOOP_TRACING: Tracing = {
  withSpan: (_name, _attributes, fn) => fn(NOOP_SPAN),
  currentTraceparent: () => undefined,
};

let current: Tracing = NOOP_TRACING;

/** Implementação ativa do processo. Troca só na inicialização (`initTracing`). */
export function getTracing(): Tracing {
  return current;
}

export function setTracing(tracing: Tracing): void {
  current = tracing;
}
