import { InvalidPayloadError } from "../../application/errors";

const PREFIX = "v1:";
const SEQ = /^[1-9]\d*$/;

/** Cursor opaco do ledger: base64url de `v1:{seq}`. */
export function encodeCursor(seq: bigint): string {
  return Buffer.from(`${PREFIX}${seq.toString()}`).toString("base64url");
}

/**
 * Decodifica o cursor. Qualquer forma diferente da gerada por `encodeCursor` lança InvalidPayloadError
 * (inclusive variantes de base64 equivalentes: a verificação é por re-encode).
 */
export function decodeCursor(cursor: string): bigint {
  const invalid = () => new InvalidPayloadError("invalid cursor");
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  if (!raw.startsWith(PREFIX)) throw invalid();
  const digits = raw.slice(PREFIX.length);
  if (!SEQ.test(digits)) throw invalid();
  if (encodeCursor(BigInt(digits)) !== cursor) throw invalid();
  return BigInt(digits);
}
