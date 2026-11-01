import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../src/application/idempotency/canonical-json";
import { wagerPayloadHash } from "../../../src/application/idempotency/payload-hash";

const base = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET" as const,
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("ordena chaves recursivamente, sem espaços", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("omite valores undefined em objetos e mantém a ordem dos arrays", () => {
    expect(canonicalJson({ x: undefined, arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
  });
});

describe("wagerPayloadHash", () => {
  test("é SHA-256 hex (64 caracteres)", () => {
    expect(wagerPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("não muda com a ordem das chaves do input", () => {
    const reordered = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET" as const,
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    };
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(base));
  });

  test("muda quando money.amount muda", () => {
    const changed = { ...base, money: { amount: "26.00", currency: "BRL" } };
    expect(wagerPayloadHash(changed)).not.toBe(wagerPayloadHash(base));
  });

  test("ignora idempotencyKey e messageId (metadados de transporte)", () => {
    const withMeta = { ...base, idempotencyKey: "provider-a:transaction-123", messageId: "msg-123" };
    expect(wagerPayloadHash(withMeta)).toBe(wagerPayloadHash(base));
  });

  test("referenceExternalTransactionId undefined é igual a campo ausente", () => {
    const withUndef = { ...base, referenceExternalTransactionId: undefined };
    expect(wagerPayloadHash(withUndef)).toBe(wagerPayloadHash(base));
  });
});
