import { join } from "node:path";
import { migrateUp } from "./db";
import { TEST_APP_DATABASE_URL, TEST_QUEUE_ENV, TEST_SQS_ENDPOINT } from "./env";
import { ensureTestQueues } from "./sqs";

export interface AppProcess {
  baseUrl: string;
  pid: number;
  /** Envia o sinal, espera o processo terminar e devolve o exit code. */
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<number>;
  waitExit(): Promise<number>;
  /** Fim do stderr capturado (diagnóstico). */
  stderr(): string;
}

export interface SpawnAppOptions {
  port: number;
  /** Valor de APP_ROLES, ex.: "api" ou "api,outbox,pending". */
  roles: string;
  env?: Record<string, string>;
}

const READY_TIMEOUT_MS = 30_000;
const APP_DIR = join(import.meta.dir, "..", "..");
const MAX_STDERR_CHARS = 8_000;

/**
 * Sobe uma instância real da aplicação (`bun run src/main.ts`) como processo separado, ligada ao
 * banco de teste do agente (TEST_DB_NAME) e ao MiniStack de teste. Roda `migrateUp()` antes e espera
 * `/health/ready` responder 200 (timeout de 30s).
 */
export async function spawnApp(opts: SpawnAppOptions): Promise<AppProcess> {
  await migrateUp();
  await ensureTestQueues();

  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: APP_DIR,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(opts.port),
      APP_ROLES: opts.roles,
      NODE_ENV: "test",
      DATABASE_URL: TEST_APP_DATABASE_URL,
      SQS_ENDPOINT: TEST_SQS_ENDPOINT,
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      LOG_LEVEL: "error",
      ...TEST_QUEUE_ENV,
      ...opts.env,
    },
  });

  // Consome o stderr para o pipe não encher e guarda o fim, para diagnosticar falha de boot.
  let stderrTail = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
      stderrTail = (stderrTail + decoder.decode(chunk)).slice(-MAX_STDERR_CHARS);
    }
  })();

  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const app: AppProcess = {
    baseUrl,
    pid: proc.pid,
    async kill(signal = "SIGTERM") {
      proc.kill(signal);
      const code = await proc.exited;
      // Um consumidor morto por SIGKILL deixa um ReceiveMessage com long poll pendente no SQS
      // (MiniStack atrás do relay do Docker no Windows não percebe o cliente morto). Esse poll
      // "fantasma" ainda recebe a próxima mensagem da fila e a deixa em voo (NotVisible) pelo
      // VisibilityTimeout inteiro. Espera o poll expirar antes de devolver o controle.
      if (signal === "SIGKILL" && opts.roles.split(",").includes("consumer")) {
        const waitSeconds = Number(opts.env?.CONSUMER_WAIT_SECONDS ?? process.env.CONSUMER_WAIT_SECONDS ?? 10);
        await Bun.sleep((waitSeconds + 2) * 1000);
      }
      return code;
    },
    waitExit: () => proc.exited,
    stderr: () => stderrTail,
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`app on port ${opts.port} exited during boot (code ${proc.exitCode}):\n${stderrTail}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) return app;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  await app.kill("SIGKILL");
  throw new Error(`app on port ${opts.port} not ready after ${READY_TIMEOUT_MS}ms:\n${stderrTail}`);
}
