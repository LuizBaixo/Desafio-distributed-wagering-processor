/** Porta de log de erro (subconjunto do pino). A implementação fica em infrastructure/observability. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const LOGGER = Symbol("LOGGER");
