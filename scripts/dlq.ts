/**
 * Operação da DLQ de transações de aposta.
 *   bun run dlq:list [--limit 10]
 *   bun run dlq:redrive [--reason INVALID_PAYLOAD] [--max 100] [--dry-run] [--include-failed]
 *
 * Redrive: copia cada mensagem para a fila principal com `MessageDeduplicationId` novo e só apaga da
 * DLQ depois do envio. O `messageId` do corpo não muda, então a inbox e a idempotência absorvem a
 * reentrega de algo que já foi processado.
 *
 * Mensagens com `reason=INFRA_PERMANENT` são puladas por padrão: a transação já está FAILED (terminal),
 * e um redrive só devolveria o replay do FAILED. `--include-failed` as move mesmo assim, com aviso.
 * A solução para essas é o provedor reenviar a aposta com um `externalTransactionId` novo.
 * Consulte o README, seção Operação, para quando o redrive faz sentido.
 *
 * Limitação de FIFO: uma mensagem em voo bloqueia as da mesma `MessageGroupId` até ela voltar. Com
 * `--reason`, as de outro motivo do mesmo grupo podem ficar para a próxima execução.
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

export interface DlqDeps {
  sqs: SQSClient;
  queues: { main: string; dlq: string };
}

export interface ListedMessage {
  messageId: string;
  reason: string;
  preview: string;
}

export interface RedriveOptions {
  reason?: string;
  max: number;
  dryRun: boolean;
  includeFailed?: boolean;
}

export interface RedriveResult {
  matched: number;
  moved: number;
  /** Mensagens INFRA_PERMANENT puladas por serem FAILED (terminal), sem `includeFailed`. */
  skippedTerminal: number;
}

/** Visibilidade enquanto a ferramenta segura a mensagem; depois ela volta a ficar visível. */
const HOLD_SECONDS = 60;
const PREVIEW_CHARS = 120;
/** Motivo da DLQ cuja transação já está FAILED (terminal): redrive não a reprocessa. */
export const TERMINAL_REASON = "INFRA_PERMANENT";

const urlCache = new Map<string, string>();
async function urlOf(deps: DlqDeps, name: string): Promise<string> {
  const cached = urlCache.get(name);
  if (cached) return cached;
  const url = (await deps.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  urlCache.set(name, url);
  return url;
}

/** Até 10 mensagens; `WaitTimeSeconds` 1 evita o short polling que pode devolver vazio com mensagens presentes. */
async function receive(deps: DlqDeps, url: string, max: number): Promise<Message[]> {
  const res = await deps.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: Math.min(10, max),
      WaitTimeSeconds: 1,
      VisibilityTimeout: HOLD_SECONDS,
      MessageAttributeNames: ["All"],
    }),
  );
  return res.Messages ?? [];
}

/** Devolve a mensagem à fila, visível de novo. */
async function release(deps: DlqDeps, url: string, messages: Message[]): Promise<void> {
  for (const m of messages) {
    if (!m.ReceiptHandle) continue;
    await deps.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }));
  }
}

function reasonOf(m: Message): string {
  return m.MessageAttributes?.reason?.StringValue ?? "unknown";
}

function parseBody(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? "");
  } catch {
    return undefined;
  }
}

/** Mensagem sem o campo `money`, truncada: o que o operador vê no list. */
export function previewOf(body: string | undefined): string {
  const json = parseBody(body) as { data?: Record<string, unknown> } | undefined;
  let text = body ?? "";
  if (json && typeof json === "object") {
    if (json.data && typeof json.data === "object") delete json.data.money;
    text = JSON.stringify(json);
  }
  return text.slice(0, PREVIEW_CHARS);
}

/** Grupo FIFO da cópia: `data.walletId`, ou `invalid` quando o corpo não tem. */
export function groupIdOf(body: string | undefined): string {
  const walletId = (parseBody(body) as { data?: { walletId?: unknown } } | undefined)?.data?.walletId;
  return typeof walletId === "string" && walletId.length > 0 && walletId.length <= 128 ? walletId : "invalid";
}

export async function listDlq(deps: DlqDeps, opts: { limit: number }): Promise<ListedMessage[]> {
  const url = await urlOf(deps, deps.queues.dlq);
  const held: Message[] = [];
  try {
    while (held.length < opts.limit) {
      const batch = await receive(deps, url, opts.limit - held.length);
      if (batch.length === 0) break;
      held.push(...batch);
    }
    return held.map((m) => {
      const parsed = parseBody(m.Body) as { messageId?: unknown } | undefined;
      return {
        messageId: typeof parsed?.messageId === "string" ? parsed.messageId : (m.MessageId ?? ""),
        reason: reasonOf(m),
        preview: previewOf(m.Body),
      };
    });
  } finally {
    await release(deps, url, held);
  }
}

export async function redriveDlq(deps: DlqDeps, opts: RedriveOptions): Promise<RedriveResult> {
  const dlqUrl = await urlOf(deps, deps.queues.dlq);
  const mainUrl = await urlOf(deps, deps.queues.main);
  const skipped: Message[] = [];
  let matched = 0;
  let moved = 0;
  let skippedTerminal = 0;
  try {
    while (matched < opts.max) {
      const batch = await receive(deps, dlqUrl, 10);
      if (batch.length === 0) break;
      for (const m of batch) {
        if ((opts.reason && reasonOf(m) !== opts.reason) || matched >= opts.max) {
          skipped.push(m);
          continue;
        }
        if (reasonOf(m) === TERMINAL_REASON && !opts.includeFailed) {
          skipped.push(m);
          skippedTerminal++;
          continue;
        }
        matched++;
        if (opts.dryRun) {
          skipped.push(m);
          continue;
        }
        await deps.sqs.send(
          new SendMessageCommand({
            QueueUrl: mainUrl,
            MessageBody: m.Body,
            MessageGroupId: groupIdOf(m.Body),
            MessageDeduplicationId: `redrive-${randomUUID()}`,
          }),
        );
        // Só apaga depois do envio bem-sucedido. Se o envio lançar, a mensagem volta à DLQ pelo timeout.
        await deps.sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: m.ReceiptHandle! }));
        moved++;
      }
    }
    return { matched, moved, skippedTerminal };
  } finally {
    await release(deps, dlqUrl, skipped);
  }
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${name} deve ser inteiro positivo, recebido: ${raw}`);
  return Number(raw);
}

function defaultDeps(): DlqDeps {
  return {
    sqs: new SQSClient({
      endpoint: process.env.SQS_ENDPOINT,
      region: process.env.AWS_REGION ?? "us-east-1",
    }),
    queues: {
      main: process.env.WAGER_QUEUE_NAME ?? "wager-transactions.fifo",
      dlq: process.env.WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo",
    },
  };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      max: { type: "string" },
      reason: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "include-failed": { type: "boolean", default: false },
    },
  });
  const deps = defaultDeps();
  const command = positionals[0];

  if (command === "list") {
    const items = await listDlq(deps, { limit: parsePositiveInt("limit", values.limit, 10) });
    for (const i of items) {
      const flag = i.reason === TERMINAL_REASON ? "  <-- FAILED (terminal): redrive pula sem --include-failed" : "";
      console.log(`${i.messageId}\t${i.reason}\t${i.preview}${flag}`);
    }
    console.log(`${items.length} mensagem(ns) listada(s)`);
    return;
  }
  if (command === "redrive") {
    const includeFailed = values["include-failed"] ?? false;
    if (includeFailed) {
      console.warn(
        `AVISO: --include-failed move mensagens ${TERMINAL_REASON}. A transação já está FAILED; o redrive só reenvia o replay do FAILED, sem reprocessar a aposta. O correto é o provedor reenviar com um externalTransactionId novo.`,
      );
    }
    const result = await redriveDlq(deps, {
      reason: values.reason,
      max: parsePositiveInt("max", values.max, 100),
      dryRun: values["dry-run"] ?? false,
      includeFailed,
    });
    const mode = values["dry-run"] ? "dry-run: nada movido" : `movidas ${result.moved}`;
    console.log(`${result.matched} mensagem(ns) selecionada(s); ${mode}`);
    if (result.skippedTerminal > 0) {
      console.log(`${result.skippedTerminal} ${TERMINAL_REASON} pulada(s) (FAILED, terminal); use --include-failed para movê-las`);
    }
    return;
  }
  throw new Error("uso: bun run scripts/dlq.ts <list|redrive> [opções]");
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
