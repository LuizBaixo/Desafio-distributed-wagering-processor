/** Executor SQL cru ligado à transação corrente (o `em` do `transactional`). Placeholders são `?`. */
export interface SqlRunner {
  execute(sql: string, params?: unknown[], method?: "all" | "get" | "run"): Promise<unknown>;
}

export class Db {
  constructor(private readonly runner: SqlRunner) {}

  async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.runner.execute(sql, params, "all")) as T[];
  }

  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.rows<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Executa e devolve o número de linhas afetadas. */
  async run(sql: string, params: unknown[] = []): Promise<number> {
    const result = (await this.runner.execute(sql, params, "run")) as { affectedRows?: number };
    return result.affectedRows ?? 0;
  }
}
