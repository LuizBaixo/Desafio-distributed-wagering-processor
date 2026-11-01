import type { Logger } from "../../src/application/ports/logger";

export interface LogEntry {
  level: "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string | undefined;
}

/** Logger fake da porta: guarda cada chamada para os testes inspecionarem campos e mensagem. */
export class CaptureLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(obj: object, msg?: string): void {
    this.entries.push({ level: "info", obj: obj as Record<string, unknown>, msg });
  }
  warn(obj: object, msg?: string): void {
    this.entries.push({ level: "warn", obj: obj as Record<string, unknown>, msg });
  }
  error(obj: object, msg?: string): void {
    this.entries.push({ level: "error", obj: obj as Record<string, unknown>, msg });
  }

  at(level: LogEntry["level"]): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  /** Todo o texto logado, para checar ausência de valores monetários. */
  dump(): string {
    return JSON.stringify(this.entries);
  }
}
