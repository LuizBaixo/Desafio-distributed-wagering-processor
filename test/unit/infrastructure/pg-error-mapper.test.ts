import { describe, expect, test } from "bun:test";
import { ConcurrencyViolationError, TransientInfrastructureError, isLockConflict } from "../../../src/application/errors";
import { mapPgError } from "../../../src/infrastructure/persistence/pg-error-mapper";

const withCode = (code: string) => Object.assign(new Error(`x ${code}`), { code });
const wrapped = (code: string) => new Error("outer", { cause: withCode(code) });

const TRANSIENT = [
  "55P03", "40001", "40P01", "57P01", "57P02", "57P03", "53300",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH",
];

describe("mapPgError transient classification", () => {
  for (const code of TRANSIENT) {
    test(`${code} is transient (direct and in .cause)`, () => {
      expect(mapPgError(withCode(code))).toBeInstanceOf(TransientInfrastructureError);
      expect(mapPgError(wrapped(code))).toBeInstanceOf(TransientInfrastructureError);
    });
  }

  for (const code of ["23505", "23514", "42P01", "22001", "0A000", "ENOENT"]) {
    test(`${code} is not transient`, () => {
      const e = withCode(code);
      expect(mapPgError(e)).toBe(e);
    });
  }

  test("only lock-class codes flag lockConflict", () => {
    for (const code of ["55P03", "40001", "40P01"]) {
      expect(isLockConflict(mapPgError(withCode(code)))).toBe(true);
    }
    for (const code of ["08006", "ECONNREFUSED", "57P01"]) {
      expect(isLockConflict(mapPgError(withCode(code)))).toBe(false);
    }
    expect(isLockConflict(new ConcurrencyViolationError())).toBe(true);
  });
});
