import { z } from "zod";

export const APP_ROLES = ["api", "consumer", "outbox", "pending"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  queues: { wager: string; wagerDlq: string; events: string };
  roles: Set<AppRole>;
  pending: { maxAttempts: number; pollMs: number };
  faultInject?: "exit_after_commit";
  consumer: {
    concurrency: number;
    shutdownGraceMs: number;
    /** VisibilityTimeout pedido no ReceiveMessage. */
    visibilityTimeoutSeconds: number;
    /** Teto do backoff exponencial de ChangeMessageVisibility. */
    maxBackoffSeconds: number;
    waitSeconds: number;
  };
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SQS_ENDPOINT: z.string().url(),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  WAGER_QUEUE_NAME: z.string().min(1).default("wager-transactions.fifo"),
  WAGER_DLQ_NAME: z.string().min(1).default("wager-transactions-dlq.fifo"),
  WALLET_EVENTS_QUEUE_NAME: z.string().min(1).default("wallet-events.fifo"),
  APP_ROLES: z
    .string()
    .default("api")
    .transform((s) => s.split(",").map((r) => r.trim()).filter((r) => r.length > 0))
    .pipe(z.array(z.enum(APP_ROLES)).min(1)),
  FAULT_INJECT: z.enum(["exit_after_commit"]).optional(),
  PENDING_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  PENDING_POLL_MS: z.coerce.number().int().positive().default(1000),
  CONSUMER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(20_000),
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  CONSUMER_MAX_BACKOFF_SECONDS: z.coerce.number().int().positive().default(60),
  CONSUMER_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${details}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sqsEndpoint: e.SQS_ENDPOINT,
    awsRegion: e.AWS_REGION,
    queues: {
      wager: e.WAGER_QUEUE_NAME,
      wagerDlq: e.WAGER_DLQ_NAME,
      events: e.WALLET_EVENTS_QUEUE_NAME,
    },
    roles: new Set(e.APP_ROLES),
    pending: { maxAttempts: e.PENDING_MAX_ATTEMPTS, pollMs: e.PENDING_POLL_MS },
    consumer: {
      concurrency: e.CONSUMER_CONCURRENCY,
      shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
      visibilityTimeoutSeconds: e.CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
      maxBackoffSeconds: e.CONSUMER_MAX_BACKOFF_SECONDS,
      waitSeconds: e.CONSUMER_WAIT_SECONDS,
    },
    ...(e.FAULT_INJECT ? { faultInject: e.FAULT_INJECT } : {}),
  };
}

/** Token de injeção da configuração validada. */
export const APP_CONFIG = Symbol("APP_CONFIG");
