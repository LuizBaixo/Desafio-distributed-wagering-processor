import { describe, expect, test } from "bun:test";
import { isUniqueViolation } from "../../../src/application/errors";

/** Cadeia de `cause` com `depth` níveis de wrapper; o erro de fundo recebe `leaf`. */
function chain(depth: number, leaf: object): unknown {
  let cur: unknown = leaf;
  for (let i = 0; i < depth; i++) cur = { message: `wrap ${i}`, cause: cur };
  return cur;
}

describe("isUniqueViolation", () => {
  test("true for a 23505 error without constraint filter", () => {
    expect(isUniqueViolation({ code: "23505", constraint: "any_uq" })).toBe(true);
  });

  test("false for other SQLSTATE codes and for non-objects", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  test("with constraints, only the listed constraint names count", () => {
    const allowed = ["wager_tx_provider_idempotency_uq", "wager_tx_provider_external_uq"];
    expect(isUniqueViolation({ code: "23505", constraint: "wager_tx_provider_external_uq" }, allowed)).toBe(true);
    expect(isUniqueViolation({ code: "23505", constraint: "inbox_pk" }, allowed)).toBe(false);
    expect(isUniqueViolation({ code: "23505" }, allowed)).toBe(false);
  });

  test("finds the violation in the cause chain", () => {
    const driver = { code: "23505", constraint: "wager_tx_provider_idempotency_uq" };
    expect(isUniqueViolation({ message: "query failed", cause: driver }, ["wager_tx_provider_idempotency_uq"])).toBe(true);
    expect(isUniqueViolation(chain(2, { code: "23505" }))).toBe(true);
  });

  test("walks at most 6 levels: the violation at level 6 (index 5) counts, at level 7 does not", () => {
    expect(isUniqueViolation(chain(5, { code: "23505" }))).toBe(true);
    expect(isUniqueViolation(chain(6, { code: "23505" }))).toBe(false);
  });

  test("stops on a cause cycle without looping forever", () => {
    const a: { code?: string; cause?: unknown } = { code: "23503" };
    a.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
