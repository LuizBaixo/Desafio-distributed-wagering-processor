export type MetricSource = "http" | "sqs" | "inbox";
export type DuplicateResult = "replay" | "conflict" | "message";

/** Porta de métricas. A implementação (prom-client) fica em infrastructure/observability. */
export interface Metrics {
  transaction(status: string, kind: string): void;
  duplicate(source: MetricSource, result: DuplicateResult): void;
  retry(component: string): void;
  dlq(): void;
  lockConflict(): void;
  /** Tempo gasto esperando o lock de wallet (`SELECT ... FOR UPDATE`), inclusive quando termina em erro. */
  observeLockWait(seconds: number): void;
  setOutboxLag(seconds: number): void;
  observeProcessing(seconds: number, source: MetricSource): void;
  reconciliationMismatch(): void;
  /** Fim de uma execução completa do job de reconciliação: `checked` wallets conferidas, em `finishedAtSeconds` (epoch). */
  reconciliationRun(checked: number, finishedAtSeconds: number): void;
}

export const METRICS = Symbol("METRICS");
