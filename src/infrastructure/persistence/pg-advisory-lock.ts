import { Client } from "pg";
import type { ExclusiveResult, ExclusiveRunner } from "../../application/ports/exclusive-runner";

/**
 * Advisory lock de sessão do Postgres numa conexão dedicada.
 *
 * O lock de sessão pertence à conexão. Por isso esta classe abre o próprio `pg.Client`, fora do pool do
 * ORM, e o mantém aberto durante todo o `work`: com uma conexão do pool, o lock se perderia (ou ficaria
 * preso) quando a conexão voltasse ao pool depois de um commit. O `pg_advisory_unlock` roda no `finally`,
 * e o fechamento do cliente também libera o lock se o unlock falhar.
 */
export class PgAdvisoryLock implements ExclusiveRunner {
  constructor(private readonly connectionString: string) {}

  async runExclusive<T>(name: string, work: () => Promise<T>): Promise<ExclusiveResult<T>> {
    // Timeouts: sem eles, um banco que não responde trava o ciclo inteiro com o lock em mãos.
    const client = new Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    // Queda da conexão no meio do ciclo: o servidor libera o lock sozinho; o erro não pode derrubar o processo.
    client.on("error", () => undefined);
    try {
      await client.connect();
      const res = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [name]);
      if (!res.rows[0]?.locked) return { acquired: false };
      try {
        return { acquired: true, value: await work() };
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => undefined);
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
