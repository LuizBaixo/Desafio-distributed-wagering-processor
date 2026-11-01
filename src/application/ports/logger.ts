/** Porta de log de erro (subconjunto do pino). A implementação fica em infrastructure/observability. */
export interface Logger {
  error(obj: object, msg?: string): void;
}

export const LOGGER = Symbol("LOGGER");
