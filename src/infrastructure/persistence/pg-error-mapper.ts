import { TransientInfrastructureError } from "../../application/errors";

/** SQLSTATE e códigos de socket tratados como falha transitória de infraestrutura. */
const TRANSIENT_CODES = new Set([
  "55P03", // lock_not_available (lock_timeout)
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND", // DNS: host não resolve
  "EAI_AGAIN", // DNS: falha temporária
  "EHOSTUNREACH",
]);

/** SQLSTATE classe 08 (connection_exception): 08000, 08001, 08003, 08004, 08006, 08007, 08P01. */
const CONNECTION_CLASS_PREFIX = "08";

function isTransientCode(code: string): boolean {
  return TRANSIENT_CODES.has(code) || code.startsWith(CONNECTION_CLASS_PREFIX);
}

/** Subconjunto de TRANSIENT_CODES que indica disputa de lock (alimenta lock_conflicts_total). */
const LOCK_CONFLICT_CODES = new Set(["55P03", "40001", "40P01"]);

const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /timeout acquiring a connection/i,
  /connection pool/i,
  /unable to acquire a connection/i,
  /cannot use a pool after calling end/i,
  /client has encountered a connection error/i,
];

function codeOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const direct = (e as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  return codeOf((e as { cause?: unknown }).cause);
}

/** Todos os `code` da cadeia (erro e `.cause`), do mais externo ao mais interno. */
function codesOf(e: unknown): string[] {
  const codes: string[] = [];
  for (let cur: unknown = e, depth = 0; typeof cur === "object" && cur !== null && depth < 6; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

/** Traduz erros do driver. Transitórios viram `TransientInfrastructureError`; o resto passa sem mudança. */
export function mapPgError(e: unknown): Error {
  if (e instanceof TransientInfrastructureError) return e;
  const codes = codesOf(e);
  const code = codes.find(isTransientCode);
  if (code !== undefined) {
    return new TransientInfrastructureError(`database unavailable (${code})`, {
      lockConflict: codes.some((c) => LOCK_CONFLICT_CODES.has(c)),
    });
  }
  if (e instanceof Error) {
    if (TRANSIENT_MESSAGES.some((re) => re.test(e.message)) || e.name === "KnexTimeoutError") {
      return new TransientInfrastructureError(e.message);
    }
    return e;
  }
  return new Error(String(e));
}

/** `true` se o erro do driver é a violação de unique indicada (código 23505, constraint opcional). */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  if (codeOf(e) !== "23505") return false;
  if (constraint === undefined) return true;
  return (e as { constraint?: string }).constraint === constraint;
}
