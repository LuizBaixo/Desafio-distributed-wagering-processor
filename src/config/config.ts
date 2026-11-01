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
  faultInject?: "exit_after_commit";
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
    ...(e.FAULT_INJECT ? { faultInject: e.FAULT_INJECT } : {}),
  };
}

/** Token de injeção da configuração validada. */
export const APP_CONFIG = Symbol("APP_CONFIG");
