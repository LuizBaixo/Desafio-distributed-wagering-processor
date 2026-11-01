import pino from "pino";
import { currentContext } from "./correlation";

/** Logger JSON com contexto injetado (correlationId, messageId, transactionId, walletId, providerId). */
export function createLogger(level: string = process.env.LOG_LEVEL ?? "info") {
  return pino({
    level,
    mixin: () => ({ ...currentContext() }),
    redact: {
      paths: ["*.money", "*.amount", "*.balance", "req.body", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
  });
}
