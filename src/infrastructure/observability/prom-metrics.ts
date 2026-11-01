import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { DuplicateResult, Metrics, MetricSource } from "../../application/ports/metrics";

/** Métricas do Design §16. Registro próprio por instância: evita conflito de nomes entre apps no mesmo processo. */
@Injectable()
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Transações por status e tipo",
    labelNames: ["status", "kind"] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "duplicates_detected_total",
    help: "Duplicatas detectadas por origem e resultado",
    labelNames: ["source", "result"] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "retries_total",
    help: "Retries por componente",
    labelNames: ["component"] as const,
    registers: [this.registry],
  });

  private readonly dlqCounter = new Counter({
    name: "dlq_messages_total",
    help: "Mensagens enviadas à DLQ",
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "lock_conflicts_total",
    help: "Conflitos de lock de wallet",
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: "outbox_lag_seconds",
    help: "Idade do evento pendente mais antigo da outbox",
    registers: [this.registry],
  });

  private readonly processing = new Histogram({
    name: "processing_duration_seconds",
    help: "Latência de processamento de transações",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  private readonly reconciliation = new Counter({
    name: "reconciliation_mismatches_total",
    help: "Divergências encontradas na reconciliação",
    registers: [this.registry],
  });

  transaction(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }

  duplicate(source: MetricSource, result: DuplicateResult): void {
    this.duplicates.inc({ source, result });
  }

  retry(component: string): void {
    this.retries.inc({ component });
  }

  dlq(): void {
    this.dlqCounter.inc();
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  observeProcessing(seconds: number, source: MetricSource): void {
    this.processing.observe({ source }, seconds);
  }

  reconciliationMismatch(): void {
    this.reconciliation.inc();
  }
}
