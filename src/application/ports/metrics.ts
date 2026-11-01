export type MetricSource = "http" | "sqs" | "inbox";
export type DuplicateResult = "replay" | "conflict" | "message";

/** Porta de métricas. A implementação (prom-client) fica em infrastructure/observability. */
export interface Metrics {
  transaction(status: string, kind: string): void;
  duplicate(source: MetricSource, result: DuplicateResult): void;
  retry(component: string): void;
  dlq(): void;
  lockConflict(): void;
  setOutboxLag(seconds: number): void;
  observeProcessing(seconds: number, source: MetricSource): void;
  reconciliationMismatch(): void;
}

export const METRICS = Symbol("METRICS");
