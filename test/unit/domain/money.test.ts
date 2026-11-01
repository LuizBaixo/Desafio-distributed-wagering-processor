import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/shared/domain-error";
import { Money } from "../../../src/domain/money/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test("round-trips amount and currency through toJSON", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  const invalidAmounts: Array<[string, string]> = [
    ["empty string", ""],
    ["no decimals", "25"],
    ["one decimal", "25.0"],
    ["three decimals", "25.001"],
    ["negative", "-1.00"],
    ["scientific notation", "1e3"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["leading space", " 1.00"],
    ["leading zero", "01.00"],
    ["19 integer digits", "1000000000000000000.00"],
  ];
  for (const [name, amount] of invalidAmounts) {
    test(`rejects ${name}`, () => {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    });
  }

  test("rejects lowercase currency", () => {
    expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
  });

  test("rejects non-string amount", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("accepts 18 integer digits (NUMERIC(20,2) max)", () => {
    expect(brl("999999999999999999.99").amount).toBe("999999999999999999.99");
  });

  test("InvalidMoneyError carries code INVALID_MONEY", () => {
    try {
      brl("x");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InvalidMoneyError).code).toBe("INVALID_MONEY");
    }
  });
});

describe("Money arithmetic", () => {
  test("0.10 + 0.20 = 0.30 exactly", () => {
    expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
  });

  test("100.00 - 80.00 = 20.00", () => {
    expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
  });

  test("20.00 - 80.00 is negative", () => {
    const r = brl("20.00").subtract(brl("80.00"));
    expect(r.isNegative()).toBe(true);
    expect(r.amount).toBe("-60.00");
  });

  test("negate of 5.00 gives -5.00", () => {
    expect(brl("5.00").negate().amount).toBe("-5.00");
  });

  test("negative sub-unit formats with sign and padding", () => {
    expect(brl("0.00").subtract(brl("0.05")).amount).toBe("-0.05");
  });

  test("is immutable: add does not change operands", () => {
    const a = brl("1.00");
    const b = brl("2.00");
    a.add(b);
    expect(a.amount).toBe("1.00");
    expect(b.amount).toBe("2.00");
  });

  test("predicates", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(brl("1.01"))).toBe(false);
  });
});

describe("Money currency mismatch", () => {
  test("add throws CurrencyMismatchError", () => {
    expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
  });
  test("subtract throws CurrencyMismatchError", () => {
    expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
  });
  test("isLessThan throws CurrencyMismatchError", () => {
    expect(() => brl("1.00").isLessThan(usd("1.00"))).toThrow(CurrencyMismatchError);
  });
  test("equals throws CurrencyMismatchError", () => {
    expect(() => brl("1.00").equals(usd("1.00"))).toThrow(CurrencyMismatchError);
  });
  test("CurrencyMismatchError carries code CURRENCY_MISMATCH", () => {
    try {
      brl("1.00").add(usd("1.00"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CurrencyMismatchError).code).toBe("CURRENCY_MISMATCH");
    }
  });
});

describe("Money serialization", () => {
  test("JSON.stringify produces string amount", () => {
    expect(JSON.stringify(brl("25.00"))).toBe('{"amount":"25.00","currency":"BRL"}');
  });
  test("toString", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });
});

describe("Money.fromPersisted", () => {
  test("accepts negative values", () => {
    expect(Money.fromPersisted("-5.00", "BRL").isNegative()).toBe(true);
  });
  test("accepts regular values", () => {
    expect(Money.fromPersisted("0.10", "BRL").amount).toBe("0.10");
  });
  test("still validates format", () => {
    expect(() => Money.fromPersisted("5", "BRL")).toThrow(InvalidMoneyError);
    expect(() => Money.fromPersisted("1e3", "BRL")).toThrow(InvalidMoneyError);
    expect(() => Money.fromPersisted("5.00", "xx")).toThrow(InvalidMoneyError);
  });
});
