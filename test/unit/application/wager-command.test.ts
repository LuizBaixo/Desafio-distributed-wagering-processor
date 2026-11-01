import { describe, expect, test } from "bun:test";
import { parseWagerCommand } from "../../../src/application/wagering/wager-command";
import { InvalidPayloadError } from "../../../src/application/errors";
import { InvalidMoneyError } from "../../../src/domain/shared/domain-error";
import { WagerTransactionKind } from "../../../src/domain/wagering/enums";

const KEY = "provider-a:transaction-123";

const validBody = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

function withBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...validBody, ...overrides };
}

function thrownOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected function to throw");
}

describe("parseWagerCommand", () => {
  test("body válido do README §9 é aceito", () => {
    const cmd = parseWagerCommand(validBody, KEY);
    expect(cmd).toEqual({
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      idempotencyKey: KEY,
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    });
  });

  test("sem Idempotency-Key dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand(validBody, undefined));
    expect(err).toBeInstanceOf(InvalidPayloadError);
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("Idempotency-Key vazia ou com espaços nas pontas dá INVALID_PAYLOAD", () => {
    expect((thrownOf(() => parseWagerCommand(validBody, "")) as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
    expect((thrownOf(() => parseWagerCommand(validBody, " k")) as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("Idempotency-Key com mais de 255 caracteres dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand(validBody, "k".repeat(256)));
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("kind OPENING dá KIND_NOT_ALLOWED", () => {
    const err = thrownOf(() => parseWagerCommand(withBody({ kind: "OPENING" }), KEY));
    expect(err).toBeInstanceOf(InvalidPayloadError);
    expect((err as InvalidPayloadError).code).toBe("KIND_NOT_ALLOWED");
  });

  test("walletId 'x' dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand(withBody({ walletId: "x" }), KEY));
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("playerId que não é UUID dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand(withBody({ playerId: "not-a-uuid" }), KEY));
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("campo extra 'foo' dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand(withBody({ foo: "bar" }), KEY));
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("money.amount numérico dá INVALID_MONEY", () => {
    const err = thrownOf(() =>
      parseWagerCommand(withBody({ money: { amount: 25, currency: "BRL" } }), KEY),
    );
    expect(err).toBeInstanceOf(InvalidMoneyError);
    expect((err as InvalidMoneyError).code).toBe("INVALID_MONEY");
  });

  test("money.amount '0.00' dá INVALID_MONEY (valor de aposta precisa ser positivo)", () => {
    const err = thrownOf(() =>
      parseWagerCommand(withBody({ money: { amount: "0.00", currency: "BRL" } }), KEY),
    );
    expect(err).toBeInstanceOf(InvalidMoneyError);
    expect((err as InvalidMoneyError).code).toBe("INVALID_MONEY");
  });

  test("REFUND sem referenceExternalTransactionId dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand(withBody({ kind: "REFUND" }), KEY));
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("ROLLBACK com referenceExternalTransactionId é aceito", () => {
    const cmd = parseWagerCommand(
      withBody({ kind: "ROLLBACK", referenceExternalTransactionId: "transaction-100" }),
      KEY,
    );
    expect(cmd.kind).toBe(WagerTransactionKind.Rollback);
    expect(cmd.referenceExternalTransactionId).toBe("transaction-100");
  });

  test("string com mais de 128 caracteres dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand(withBody({ roundId: "r".repeat(129) }), KEY));
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });

  test("body que não é objeto dá INVALID_PAYLOAD", () => {
    const err = thrownOf(() => parseWagerCommand("oi", KEY));
    expect((err as InvalidPayloadError).code).toBe("INVALID_PAYLOAD");
  });
});
