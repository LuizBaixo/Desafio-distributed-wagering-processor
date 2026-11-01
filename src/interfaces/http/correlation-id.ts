import { randomUUID } from "node:crypto";

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Aceita o `X-Correlation-Id` só no formato seguro; senão gera outro (o valor recebido nunca é refletido). */
export function safeCorrelationId(raw: string | undefined): string {
  return raw !== undefined && SAFE.test(raw) ? raw : randomUUID();
}
