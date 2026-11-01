import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Executa `fn` com o contexto de log ativo para todas as operações assíncronas dentro dele. */
export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Contexto de log atual; vazio fora de `runWithContext`. */
export function currentContext(): Partial<LogContext> {
  return storage.getStore() ?? {};
}
