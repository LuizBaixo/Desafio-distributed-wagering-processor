/**
 * Teste de carga (README §14). Gerador próprio em Bun: N usuários virtuais em loop fechado
 * (cada um faz um fetch, espera a resposta e faz o próximo). Sem dependência nova.
 *
 * Variáveis de ambiente:
 *   LOAD_TARGETS      URLs base separadas por vírgula, round-robin (padrão: localhost:3001..3003)
 *   LOAD_CONCURRENCY  usuários virtuais (padrão 50)
 *   LOAD_DURATION_S   janela medida, em segundos (padrão 30)
 *   LOAD_WARMUP_S     aquecimento ANTES da janela medida, em segundos (padrão 5); não entra nas latências
 *   LOAD_PROFILES     spread,hot,mixed (padrão: os três)
 *   LOAD_SINK_WORKERS workers do consumidor downstream simulado em wallet-events.fifo (padrão 4; 0 desliga)
 *   LOAD_SINK_ENDPOINT endpoint SQS do sink (padrão http://localhost:4566)
 *   LOAD_EVENTS_QUEUE fila de eventos da outbox (padrão wallet-events.fifo)
 *
 * Sai com código 1 se alguma wallet divergir na reconciliação ao fim de um perfil.
 */
import { DeleteMessageBatchCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

// ------------------------------------------------------------------------------------------ config

const TARGETS = (process.env.LOAD_TARGETS ?? "http://localhost:3001,http://localhost:3002,http://localhost:3003")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter((s) => s.length > 0);
const CONCURRENCY = intEnv("LOAD_CONCURRENCY", 50);
const DURATION_S = intEnv("LOAD_DURATION_S", 30);
const WARMUP_S = intEnv("LOAD_WARMUP_S", 5);
const PROFILES = (process.env.LOAD_PROFILES ?? "spread,hot,mixed")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const PROVIDER = "load-test";
const CURRENCY = "BRL";
const INITIAL_BALANCE = "1000000000.00";
const REQUEST_TIMEOUT_MS = 15_000;
const DRAIN_TIMEOUT_MS = 60_000;
/** Antes de cada perfil, espera o backlog do perfil anterior sumir para os perfis não se contaminarem. */
const SETTLE_TIMEOUT_MS = 900_000;
const SPREAD_WALLETS = 200;
const MIXED_WALLETS = 200;
const SINK_WORKERS = intEnv("LOAD_SINK_WORKERS", 4);
const SINK_ENDPOINT = process.env.LOAD_SINK_ENDPOINT ?? "http://localhost:4566";
const EVENTS_QUEUE = process.env.LOAD_EVENTS_QUEUE ?? "wallet-events.fifo";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

// ------------------------------------------------------------------------------------------ http

type Outcome = "ok" | "rejected" | "error";

interface Sample {
  latencyMs: number;
  status: number | "timeout" | "network";
  outcome: Outcome;
  failureCode: string | null;
  replay: boolean;
  /** Para replays: o servidor respondeu idempotentReplay=true? */
  replayFlagged: boolean | null;
  measured: boolean;
}

interface WagerRequest {
  key: string;
  body: string;
}

let rr = 0;
const nextTarget = (): string => TARGETS[rr++ % TARGETS.length]!;

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{
  status: number | "timeout" | "network";
  json: unknown;
}> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // corpo vazio ou inválido
    }
    return { status: res.status, json };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", json: null };
  }
}

async function createWallets(n: number): Promise<Array<{ id: string; playerId: string }>> {
  const ids: Array<{ id: string; playerId: string }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < n) {
      next++;
      const r = await post(
        `${nextTarget()}/wallets`,
        JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: INITIAL_BALANCE, currency: CURRENCY } }),
      );
      const w = r.json as { id?: string; playerId?: string } | null;
      if (r.status !== 201 || w?.id === undefined || w.playerId === undefined) {
        throw new Error(`wallet setup failed: status ${String(r.status)}`);
      }
      ids.push({ id: w.id, playerId: w.playerId });
    }
  }
  await Promise.all(Array.from({ length: Math.min(20, n) }, worker));
  return ids;
}

// ------------------------------------------------------------------------------------------ stats

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  // nearest-rank, exato: menor valor tal que pelo menos p% das amostras são <= a ele
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

function summarize(values: number[]): { count: number; mean: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = Float64Array.from(values).sort();
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    mean: values.length ? sum / values.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1]! : 0,
  };
}

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------------------------------ metrics

type Series = Map<string, number>;

/** Lê /metrics e devolve, por métrica, as séries `labels -> valor`. */
async function scrape(base: string): Promise<Map<string, Series>> {
  const res = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(5_000) });
  const out = new Map<string, Series>();
  for (const line of (await res.text()).split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const series = out.get(m[1]!) ?? new Map<string, number>();
    series.set(m[2] ?? "", Number(m[3]));
    out.set(m[1]!, series);
  }
  return out;
}

async function scrapeAll(): Promise<Array<Map<string, Series>>> {
  return Promise.all(TARGETS.map(scrape));
}

function labelOf(labels: string, name: string): string {
  return new RegExp(`${name}="([^"]*)"`).exec(labels)?.[1] ?? "";
}

/** Soma entre os alvos, agrupando por um label (ou "" para o total). */
function sumBy(snaps: Array<Map<string, Series>>, metric: string, label?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const snap of snaps) {
    for (const [labels, v] of snap.get(metric) ?? []) {
      const k = label ? labelOf(labels, label) : "total";
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

function delta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

async function maxOutboxLag(): Promise<number> {
  const snaps = await scrapeAll();
  let max = 0;
  for (const snap of snaps) for (const v of snap.get("outbox_lag_seconds")?.values() ?? []) max = Math.max(max, v);
  return max;
}

// ------------------------------------------------------------------------------------------ events sink

/**
 * Consumidor downstream simulado: esvazia a fila de eventos durante todo o run, inclusive na espera de
 * drenagem. Sem ele, o backlog de wallet-events.fifo cresce e o próprio envio da outbox fica mais lento.
 */
interface Sink {
  received(): number;
  stop(): Promise<void>;
}

async function startSink(): Promise<Sink | undefined> {
  if (SINK_WORKERS === 0) return undefined;
  const sqs = new SQSClient({
    endpoint: SINK_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const QueueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: EVENTS_QUEUE }))).QueueUrl!;
  let received = 0;
  let running = true;
  const workers = Array.from({ length: SINK_WORKERS }, async () => {
    while (running) {
      try {
        const res = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
        );
        const messages = res.Messages ?? [];
        if (messages.length === 0) continue;
        const del = await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl,
            Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
          }),
        );
        received += del.Successful?.length ?? 0;
      } catch {
        // falha transitória do endpoint: tenta de novo
        await Bun.sleep(500);
      }
    }
  });
  return {
    received: () => received,
    async stop() {
      running = false;
      await Promise.all(workers);
      sqs.destroy();
    },
  };
}

let sink: Sink | undefined;

// ------------------------------------------------------------------------------------------ profiles

interface Profile {
  name: string;
  walletCount: number;
  /** Uma rodada de um usuário virtual: devolve as requisições a enviar, em ordem, decididas a cada passo. */
  round(ctx: RoundContext): AsyncGenerator<WagerRequest & { replay?: boolean }, void, WagerResultHint>;
}

interface RoundContext {
  wallets: string[];
  players: Map<string, string>;
  runId: string;
  /** Requisições recentes deste usuário virtual, para replay. */
  history: WagerRequest[];
  counter: () => number;
}

/** O gerador recebe de volta o resultado da requisição anterior (para a WIN/LOSS/REFUND saber se a BET passou). */
type WagerResultHint = { status: number | "timeout" | "network" } | undefined;

function wagerBody(
  ctx: RoundContext,
  walletId: string,
  kind: string,
  amount: string,
  externalId: string,
  reference?: string,
  roundId = `round-${externalId}`,
): WagerRequest {
  const key = `${PROVIDER}:${externalId}`;
  return {
    key,
    body: JSON.stringify({
      providerId: PROVIDER,
      externalTransactionId: externalId,
      playerId: ctx.players.get(walletId),
      walletId,
      roundId,
      gameId: "load-game",
      kind,
      money: { amount, currency: CURRENCY },
      ...(reference !== undefined ? { referenceExternalTransactionId: reference } : {}),
    }),
  };
}

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

const PROFILE_DEFS: Record<string, Profile> = {
  spread: {
    name: "spread",
    walletCount: SPREAD_WALLETS,
    async *round(ctx) {
      const id = `${ctx.runId}-${ctx.counter()}`;
      yield wagerBody(ctx, pick(ctx.wallets), "BET", "1.00", id);
    },
  },
  hot: {
    name: "hot",
    walletCount: 1,
    async *round(ctx) {
      const id = `${ctx.runId}-${ctx.counter()}`;
      yield wagerBody(ctx, ctx.wallets[0]!, "BET", "1.00", id);
    },
  },
  mixed: {
    name: "mixed",
    walletCount: MIXED_WALLETS,
    async *round(ctx) {
      const wallet = pick(ctx.wallets);
      const betId = `${ctx.runId}-${ctx.counter()}`;
      const hint = yield wagerBody(ctx, wallet, "BET", "1.00", betId);
      // Só encadeia se a BET foi aceita; em erro, a rodada termina sem gerar referência órfã.
      if (!hint || (hint.status !== 200 && hint.status !== 202)) return;
      const roll = Math.random();
      const followId = `${ctx.runId}-${ctx.counter()}`;
      if (roll < 0.5) yield wagerBody(ctx, wallet, "WIN", "2.00", followId, betId, `round-${betId}`);
      else if (roll < 0.8) yield wagerBody(ctx, wallet, "LOSS", "1.00", followId, betId, `round-${betId}`);
      else yield wagerBody(ctx, wallet, "REFUND", "1.00", followId, betId, `round-${betId}`);
    },
  },
};

// ------------------------------------------------------------------------------------------ run

interface ProfileResult {
  profile: string;
  wallets: number;
  concurrency: number;
  warmupS: number;
  durationS: number;
  requests: number;
  warmupRequests: number;
  throughputRps: number;
  latencyMs: { mean: number; p50: number; p95: number; p99: number; max: number };
  outcomes: { ok: number; rejected: number; error: number; errorRate: number };
  byStatus: Record<string, number>;
  byFailureCode: Record<string, number>;
  errors: { http5xx: number; timeout: number; network: number; otherHttp: number };
  replays: { sent: number; flaggedIdempotentReplay: number };
  server: {
    note: string;
    lockConflictsDelta: number;
    transactionsByStatusDelta: Record<string, number>;
    transactionsByKindDelta: Record<string, number>;
    retriesByComponentDelta: Record<string, number>;
    duplicatesDelta: Record<string, number>;
  };
  outboxLagSeconds: { samples: number; max: number; p95: number };
  outboxDrain: { drained: boolean; seconds: number; lagSecondsAtEnd: number };
  preSettle: { settled: boolean; seconds: number };
  sink: { received: number; ratePerSecond: number; workers: number };
  reconciliation: { checked: number; inconsistent: number; failures: number; inconsistentWallets: string[] };
}

async function runProfile(def: Profile): Promise<ProfileResult> {
  console.log(`\n=== perfil ${def.name}: ${def.walletCount} wallet(s), ${CONCURRENCY} VUs, aquecimento ${WARMUP_S}s + ${DURATION_S}s medidos`);

  const settleStart = performance.now();
  let settled = false;
  while (performance.now() - settleStart < SETTLE_TIMEOUT_MS) {
    try {
      if ((await maxOutboxLag()) === 0) {
        settled = true;
        break;
      }
    } catch {
      // tenta de novo
    }
    await Bun.sleep(1000);
  }
  const settleSeconds = (performance.now() - settleStart) / 1000;
  if (settleSeconds > 2) console.log(`    backlog anterior da outbox: esperou ${round(settleSeconds)}s (settled=${settled})`);

  const sinkStart = performance.now();
  const sinkBefore = sink?.received() ?? 0;

  const created = await createWallets(def.walletCount);
  const wallets = created.map((w) => w.id);
  const players = new Map(created.map((w) => [w.id, w.playerId]));

  const runId = crypto.randomUUID().slice(0, 8);
  let seq = 0;
  const samples: Sample[] = [];
  const before = await scrapeAll();

  const startedAt = performance.now();
  const measureFrom = startedAt + WARMUP_S * 1000;
  const endAt = measureFrom + DURATION_S * 1000;

  // Amostragem do lag da outbox a cada 1 s, só durante a janela do perfil.
  const lagSamples: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        lagSamples.push(await maxOutboxLag());
      } catch {
        // alvo momentaneamente fora: sem amostra neste segundo
      }
      await Bun.sleep(1000);
    }
  })();

  async function send(req: WagerRequest, replay: boolean): Promise<Sample & { json: unknown }> {
    const t0 = performance.now();
    const r = await post(`${nextTarget()}/wagering/transactions`, req.body, { "idempotency-key": req.key });
    const latencyMs = performance.now() - t0;
    let outcome: Outcome;
    if (r.status === 200 || r.status === 202) outcome = "ok";
    else if (r.status === 409 || r.status === 422) outcome = "rejected";
    else outcome = "error";
    const body = r.json as { failureCode?: string | null; idempotentReplay?: boolean; error?: { code?: string } } | null;
    return {
      latencyMs,
      status: r.status,
      outcome,
      failureCode: outcome === "rejected" ? (body?.failureCode ?? body?.error?.code ?? "UNKNOWN") : null,
      replay,
      replayFlagged: replay ? body?.idempotentReplay === true : null,
      measured: t0 >= measureFrom,
      json: r.json,
    };
  }

  async function vu(): Promise<void> {
    const ctx: RoundContext = { wallets, players, runId, history: [], counter: () => ++seq };
    while (performance.now() < endAt) {
      const gen = def.round(ctx);
      let step = await gen.next(undefined);
      while (!step.done) {
        const req = step.value;
        // 10% das requisições no perfil mixed repetem uma anterior (mesma Idempotency-Key).
        if (def.name === "mixed" && ctx.history.length > 0 && Math.random() < 0.1) {
          const prev = pick(ctx.history);
          const { json: _j, ...s } = await send(prev, true);
          samples.push(s);
          if (performance.now() >= endAt) break;
        }
        const { json: _json, ...sample } = await send(req, false);
        samples.push(sample);
        ctx.history.push(req);
        if (ctx.history.length > 50) ctx.history.shift();
        if (performance.now() >= endAt) break;
        step = await gen.next({ status: sample.status });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, vu));
  const loadEndedAt = performance.now();
  sampling = false;
  await sampler;
  const after = await scrapeAll();

  // Drenagem da outbox.
  let drained = false;
  while (performance.now() - loadEndedAt < DRAIN_TIMEOUT_MS) {
    try {
      if ((await maxOutboxLag()) === 0) {
        drained = true;
        break;
      }
    } catch {
      // tenta de novo
    }
    await Bun.sleep(500);
  }
  const drainSeconds = (performance.now() - loadEndedAt) / 1000;
  const lagAtEnd = await maxOutboxLag().catch(() => -1);
  const sinkReceived = (sink?.received() ?? 0) - sinkBefore;
  const sinkSeconds = (performance.now() - sinkStart) / 1000;

  // Reconciliação de TODAS as wallets do perfil.
  const reconciliation = { checked: 0, inconsistent: 0, failures: 0, inconsistentWallets: [] as string[] };
  let ri = 0;
  await Promise.all(
    Array.from({ length: Math.min(20, wallets.length) }, async () => {
      while (ri < wallets.length) {
        const id = wallets[ri++]!;
        const r = await post(`${nextTarget()}/wallets/${id}/reconciliation`, "{}");
        reconciliation.checked++;
        if (r.status !== 200) {
          reconciliation.failures++;
          reconciliation.inconsistentWallets.push(id);
        } else if ((r.json as { consistent?: boolean } | null)?.consistent !== true) {
          reconciliation.inconsistent++;
          reconciliation.inconsistentWallets.push(id);
        }
      }
    }),
  );

  // Agregação.
  const measured = samples.filter((s) => s.measured);
  const lat = summarize(measured.map((s) => s.latencyMs));
  const byStatus: Record<string, number> = {};
  const byFailureCode: Record<string, number> = {};
  const errors = { http5xx: 0, timeout: 0, network: 0, otherHttp: 0 };
  let ok = 0;
  let rejected = 0;
  let error = 0;
  let replaysSent = 0;
  let replaysFlagged = 0;
  for (const s of measured) {
    byStatus[String(s.status)] = (byStatus[String(s.status)] ?? 0) + 1;
    if (s.outcome === "ok") ok++;
    else if (s.outcome === "rejected") {
      rejected++;
      byFailureCode[s.failureCode ?? "UNKNOWN"] = (byFailureCode[s.failureCode ?? "UNKNOWN"] ?? 0) + 1;
    } else {
      error++;
      if (s.status === "timeout") errors.timeout++;
      else if (s.status === "network") errors.network++;
      else if (s.status >= 500) errors.http5xx++;
      else errors.otherHttp++;
    }
    if (s.replay) {
      replaysSent++;
      if (s.replayFlagged) replaysFlagged++;
    }
  }

  const sortedLag = Float64Array.from(lagSamples).sort();
  const result: ProfileResult = {
    profile: def.name,
    wallets: wallets.length,
    concurrency: CONCURRENCY,
    warmupS: WARMUP_S,
    durationS: DURATION_S,
    requests: measured.length,
    warmupRequests: samples.length - measured.length,
    throughputRps: round(measured.length / DURATION_S),
    latencyMs: { mean: round(lat.mean), p50: round(lat.p50), p95: round(lat.p95), p99: round(lat.p99), max: round(lat.max) },
    outcomes: { ok, rejected, error, errorRate: measured.length ? round(error / measured.length, 5) : 0 },
    byStatus,
    byFailureCode,
    errors,
    replays: { sent: replaysSent, flaggedIdempotentReplay: replaysFlagged },
    server: {
      note: "deltas cobrem o perfil inteiro (aquecimento + janela medida + requisições em voo no fim), não só a janela medida",
      lockConflictsDelta: delta(sumBy(before, "lock_conflicts_total"), sumBy(after, "lock_conflicts_total"))["total"] ?? 0,
      transactionsByStatusDelta: delta(sumBy(before, "wager_transactions_total", "status"), sumBy(after, "wager_transactions_total", "status")),
      transactionsByKindDelta: delta(sumBy(before, "wager_transactions_total", "kind"), sumBy(after, "wager_transactions_total", "kind")),
      retriesByComponentDelta: delta(sumBy(before, "retries_total", "component"), sumBy(after, "retries_total", "component")),
      duplicatesDelta: delta(
        sumBy(before, "duplicates_detected_total", "result"),
        sumBy(after, "duplicates_detected_total", "result"),
      ),
    },
    outboxLagSeconds: {
      samples: lagSamples.length,
      max: round(sortedLag.length ? sortedLag[sortedLag.length - 1]! : 0),
      p95: round(percentile(sortedLag, 0.95)),
    },
    outboxDrain: { drained, seconds: round(drainSeconds), lagSecondsAtEnd: round(lagAtEnd) },
    preSettle: { settled, seconds: round(settleSeconds) },
    sink: {
      received: sinkReceived,
      ratePerSecond: round(sinkReceived / sinkSeconds),
      workers: SINK_WORKERS,
    },
    reconciliation,
  };
  return result;
}

// ------------------------------------------------------------------------------------------ output

async function environment(): Promise<Record<string, unknown>> {
  const cpus = os.cpus();
  let docker = "unavailable";
  try {
    const p = Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0) docker = p.stdout.toString().trim();
  } catch {
    // docker não está no PATH
  }
  return {
    cpuModel: cpus[0]?.model.trim() ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryGiB: round(os.totalmem() / 1024 ** 3),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    bunVersion: Bun.version,
    dockerServerVersion: docker,
    loadGeneratorLocation: "mesma máquina que os containers (compete por CPU com app, Postgres e MiniStack)",
  };
}

function printTable(results: ProfileResult[]): void {
  const rows = results.map((r) => ({
    perfil: r.profile,
    "req (medidas)": r.requests,
    "req/s": r.throughputRps,
    "p50 ms": r.latencyMs.p50,
    "p95 ms": r.latencyMs.p95,
    "p99 ms": r.latencyMs.p99,
    "max ms": r.latencyMs.max,
    "média ms": r.latencyMs.mean,
    "erro %": round(r.outcomes.errorRate * 100, 3),
    "rejeições": r.outcomes.rejected,
    "lock confl.": r.server.lockConflictsDelta,
    "lag máx s": r.outboxLagSeconds.max,
    "lag p95 s": r.outboxLagSeconds.p95,
    "drenagem s": r.outboxDrain.drained ? r.outboxDrain.seconds : `>${DRAIN_TIMEOUT_MS / 1000}`,
    "sink/s": r.sink.ratePerSecond,
    "reconc. ruins": r.reconciliation.inconsistent + r.reconciliation.failures,
  }));
  console.log("\n");
  console.table(rows);
  for (const r of results) {
    console.log(`\n[${r.profile}] status HTTP:`, r.byStatus, "| failureCode:", r.byFailureCode);
    console.log(`[${r.profile}] erros:`, r.errors, "| replays:", r.replays);
    console.log(
      `[${r.profile}] servidor: tx por status`,
      r.server.transactionsByStatusDelta,
      "| retries",
      r.server.retriesByComponentDelta,
      "| duplicatas",
      r.server.duplicatesDelta,
    );
  }
}

async function main(): Promise<void> {
  for (const p of PROFILES) if (!(p in PROFILE_DEFS)) throw new Error(`unknown profile "${p}" (use spread, hot, mixed)`);
  if (TARGETS.length === 0) throw new Error("LOAD_TARGETS is empty");

  const startedAtIso = new Date().toISOString();
  const env = await environment();
  console.log("alvos:", TARGETS.join(", "));
  console.log("ambiente:", env);

  sink = await startSink();
  const results: ProfileResult[] = [];
  try {
    for (const name of PROFILES) results.push(await runProfile(PROFILE_DEFS[name]!));
  } finally {
    await sink?.stop();
  }

  printTable(results);

  const bad = results.filter((r) => r.reconciliation.inconsistent + r.reconciliation.failures > 0);
  const out = {
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    environment: env,
    parameters: {
      targets: TARGETS,
      concurrency: CONCURRENCY,
      durationS: DURATION_S,
      warmupS: WARMUP_S,
      profiles: PROFILES,
      sinkWorkers: SINK_WORKERS,
      sinkEndpoint: SINK_WORKERS > 0 ? SINK_ENDPOINT : null,
      eventsQueue: EVENTS_QUEUE,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
      preProfileSettleTimeoutMs: SETTLE_TIMEOUT_MS,
      initialBalance: INITIAL_BALANCE,
    },
    methodology: {
      model: "loop fechado: cada usuário virtual envia uma requisição, espera a resposta e envia a próxima; sem taxa alvo",
      warmup: "o aquecimento roda antes da janela medida; requisições iniciadas nele não entram nas latências nem no throughput",
      latency: "performance.now() ao redor do fetch, por requisição; percentis exatos por nearest-rank sobre o array ordenado",
      throughput: "requisições iniciadas na janela medida / duração da janela",
      classification: "200 e 202 sucesso; 409 e 422 rejeição de negócio esperada; 5xx, timeout, erro de rede e demais status são erro",
      outboxLag: "gauge outbox_lag_seconds lido em todos os alvos a cada 1 s (máximo entre alvos por amostra); drenagem = tempo até lag 0 em todos, no máximo 60 s",
      isolation: "antes de cada perfil o script espera o outbox_lag_seconds chegar a 0 (até 900 s), para o backlog de um perfil não contaminar o seguinte; o tempo fica em preSettle",
      correctness: "POST /wallets/:id/reconciliation em todas as wallets do perfil após a drenagem",
    },
    results,
    passed: bad.length === 0,
  };

  const dir = join(import.meta.dir, "..", "docs", "load-test");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `results-${new Date().toISOString().replace(/:/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nresultado gravado em ${file}`);

  if (bad.length > 0) {
    console.error(`\nFALHA: reconciliação divergente nos perfis: ${bad.map((b) => b.profile).join(", ")}`);
    process.exit(1);
  }
}

await main();
