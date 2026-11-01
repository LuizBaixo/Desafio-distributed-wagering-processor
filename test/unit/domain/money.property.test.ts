import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { InvalidMoneyError } from "../../../src/domain/shared/domain-error";
import { Money } from "../../../src/domain/money/money";

const RUNS = { numRuns: 500 };

/** Centavos não negativos, formatados como `amount` de entrada (`N.NN`). */
const centsArb = fc.bigInt({ min: 0n, max: 99999999999999999999n });
const toAmount = (c: bigint): string => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
const moneyArb = centsArb.map((c) => Money.from({ amount: toAmount(c), currency: "BRL" }));

const INPUT_AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const PERSISTED_SHAPE = /^-?\d+\.\d{2}$/;

describe("Money: propriedades", () => {
  test("a.add(b).subtract(b) é igual a a", () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (a, b) => {
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
      RUNS,
    );
  });

  test("add é comutativo", () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (a, b) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
      RUNS,
    );
  });

  test("add é associativo", () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, moneyArb, (a, b, c) => {
        expect(a.add(b).add(c).equals(a.add(b.add(c)))).toBe(true);
      }),
      RUNS,
    );
  });

  test("Money.from(m.toJSON()) é igual a m para m não negativo", () => {
    fc.assert(
      fc.property(moneyArb, (m) => {
        expect(Money.from(m.toJSON()).equals(m)).toBe(true);
      }),
      RUNS,
    );
  });

  test("amount sempre bate com ^-?\\d+\\.\\d{2}$, inclusive para resultados negativos", () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (a, b) => {
        expect(a.amount).toMatch(PERSISTED_SHAPE);
        expect(a.subtract(b).amount).toMatch(PERSISTED_SHAPE);
        expect(b.subtract(a).amount).toMatch(PERSISTED_SHAPE);
      }),
      RUNS,
    );
  });

  test("string fora do formato de entrada nunca vira Money (InvalidMoneyError)", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !INPUT_AMOUNT.test(s)),
        (s) => {
          expect(() => Money.from({ amount: s, currency: "BRL" })).toThrow(InvalidMoneyError);
        },
      ),
      RUNS,
    );
  });
});
