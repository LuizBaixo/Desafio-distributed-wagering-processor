import { z } from "zod";

export const APP_ROLES = ["api", "consumer", "outbox", "pending", "reconciler", "retention"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export type AuthConfig =
  | { mode: "disabled" }
  | { mode: "oidc"; issuer: string; audience: string; jwksUrl: string; jwksTimeoutMs: number };

export interface AppConfig {
  /** `NODE_ENV=production`: ativa as validações de configuração segura. */
  production: boolean;
  auth: AuthConfig;
  port: number;
  /** Swagger UI em /docs e /docs-json. */
  docsEnabled: boolean;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  queues: { wager: string; wagerDlq: string; events: string };
  roles: Set<AppRole>;
  pending: { maxAttempts: number; pollMs: number };
  outbox: { pollMs: number; batchSize: number; sendBatch: number; maxAttempts: number };
  reconciliation: { intervalMs: number };
  retention: { outboxHours: number; inboxHours: number; intervalMs: number };
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
  NODE_ENV: z.string().optional(),
  AUTH_MODE: z.enum(["disabled", "oidc"]).optional(),
  OIDC_ISSUER: z.string().min(1).optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  OIDC_JWKS_URL: z.string().url().optional(),
  // Timeout de cada busca do JWKS: IdP pendurado não pode segurar requisições por 5 s (A-R2-03).
  OIDC_JWKS_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  AWS_ACCESS_KEY_ID: z.string().optional(),
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
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  OUTBOX_RETENTION_HOURS: z.coerce.number().int().positive().default(168),
  // Mínimo de 24 h: a inbox é o que impede a dupla aplicação de uma mensagem reentregue pelo SQS.
  INBOX_RETENTION_HOURS: z.coerce.number().int().min(24).default(168),
  RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  OUTBOX_SEND_BATCH: z.coerce.number().int().positive().max(10).default(10),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(50),
  CONSUMER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(20_000),
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  CONSUMER_MAX_BACKOFF_SECONDS: z.coerce.number().int().positive().default(60),
  CONSUMER_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  // /docs (OpenAPI UI). Ausente: ligado fora de NODE_ENV=production, desligado nele.
  DOCS_ENABLED: z.enum(["true", "false"]).optional(),
});

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Únicos NODE_ENV que não são produção. Qualquer outro valor (inclusive ausente) é produção. */
const NON_PRODUCTION_NODE_ENVS = ["development", "test"];

/**
 * Senhas padrão dos papéis de desenvolvimento (docker-compose, init-roles.sql), em minúsculas.
 * Comparadas depois de decodificar a URL, sem depender do usuário.
 */
const DEFAULT_DB_PASSWORDS = ["postgres", "owner", "app", "admin", "password", "test", "changeme"];
const MIN_DB_PASSWORD_LENGTH = 12;
/** Chaves de exemplo/desenvolvimento, em minúsculas: 'test' e a chave de exemplo da documentação da AWS. */
const DEV_AWS_KEYS = ["test", "akiaiosfodnn7example"];

function decodeOrRaw(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Senhas presentes na URL do banco: a da parte userinfo (decodificada) e a do parâmetro `password`.
 * Sem senha, lista vazia. URL inválida: `null`.
 */
function databasePasswords(databaseUrl: string): string[] | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  const passwords: string[] = [];
  if (url.password !== "") passwords.push(decodeOrRaw(url.password));
  const queryPassword = url.searchParams.get("password");
  if (queryPassword !== null) passwords.push(queryPassword);
  return passwords;
}

function isWeakDbPassword(password: string): boolean {
  return password.length < MIN_DB_PASSWORD_LENGTH || DEFAULT_DB_PASSWORDS.includes(password.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${details}`);
  }
  const e = parsed.data;
  // Fail-safe (B-12): só development e test (após trim e lowercase) desligam as validações de produção.
  // NODE_ENV ausente, 'Production', 'prod' ou 'staging' são tratados como produção.
  const production = !NON_PRODUCTION_NODE_ENVS.includes((e.NODE_ENV ?? "").trim().toLowerCase());
  const problems: string[] = [];

  if (e.AUTH_MODE === "oidc") {
    for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URL"] as const) {
      if (e[name] === undefined) problems.push(`${name}: required when AUTH_MODE=oidc`);
    }
  }
  if (production) {
    if (e.AUTH_MODE === undefined) problems.push("AUTH_MODE: must be set explicitly (disabled or oidc) in production");
    // A mensagem nomeia a variável e nunca repete o valor, que carrega a senha.
    const passwords = databasePasswords(e.DATABASE_URL);
    if (passwords === null) {
      problems.push("DATABASE_URL: not a valid URL");
    } else if (passwords.some(isWeakDbPassword)) {
      problems.push(
        `DATABASE_URL: password is a default or shorter than ${MIN_DB_PASSWORD_LENGTH} characters, not allowed in production`,
      );
    }
    if (DEV_AWS_KEYS.includes((e.AWS_ACCESS_KEY_ID ?? "").trim().toLowerCase())) {
      problems.push("AWS_ACCESS_KEY_ID: a development or example key is not allowed in production");
    }
    if ((env.AWS_SECRET_ACCESS_KEY ?? "").trim().toLowerCase() === "test") {
      problems.push("AWS_SECRET_ACCESS_KEY: the development value 'test' is not allowed in production");
    }
    // O IdP é a raiz de confiança da autenticação: em produção só https (A-R2-07).
    for (const name of ["OIDC_ISSUER", "OIDC_JWKS_URL"] as const) {
      const value = e[name];
      if (value !== undefined && !isHttps(value)) {
        problems.push(`${name}: must be an https URL in production`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`invalid configuration: ${problems.join("; ")}`);

  const auth: AuthConfig =
    e.AUTH_MODE === "oidc"
      ? {
          mode: "oidc",
          issuer: e.OIDC_ISSUER!,
          audience: e.OIDC_AUDIENCE!,
          jwksUrl: e.OIDC_JWKS_URL!,
          jwksTimeoutMs: e.OIDC_JWKS_TIMEOUT_MS,
        }
      : { mode: "disabled" };

  return {
    production,
    auth,
    port: e.PORT,
    docsEnabled: e.DOCS_ENABLED !== undefined ? e.DOCS_ENABLED === "true" : !production,
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
    outbox: { pollMs: e.OUTBOX_POLL_MS, batchSize: e.OUTBOX_BATCH_SIZE, sendBatch: e.OUTBOX_SEND_BATCH,
      maxAttempts: e.OUTBOX_MAX_ATTEMPTS,
    },
    reconciliation: { intervalMs: e.RECONCILE_INTERVAL_MS },
    retention: {
      outboxHours: e.OUTBOX_RETENTION_HOURS,
      inboxHours: e.INBOX_RETENTION_HOURS,
      intervalMs: e.RETENTION_INTERVAL_MS,
    },
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
