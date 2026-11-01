import { CurrencyMismatchError, InvalidMoneyError } from "../shared/domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Entrada: até 18 dígitos inteiros (cabe em NUMERIC(20,2)), sem zero à esquerda, exatamente 2 casas.
const INPUT_AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
// Persistido: mesmo formato, com sinal opcional (só para resultados de negate/subtract).
const PERSISTED_AMOUNT = /^-?(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

function parseCents(amount: unknown, currency: unknown, pattern: RegExp): bigint {
  if (typeof amount !== "string" || !pattern.test(amount)) {
    throw new InvalidMoneyError("amount must be a decimal string with exactly 2 decimal places");
  }
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    throw new InvalidMoneyError("currency must be 3 uppercase letters");
  }
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).replace(".", "");
  const cents = BigInt(digits);
  return negative ? -cents : cents;
}

export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {}

  /** Contrato de entrada: rejeita negativo e qualquer formato fora de `^(0|[1-9]\d{0,17})\.\d{2}$`. */
  static from(props: MoneyProps): Money {
    return new Money(parseCents(props.amount, props.currency, INPUT_AMOUNT), props.currency);
  }

  /** Valor vindo do banco ou de negate/subtract; aceita sinal negativo, valida formato. */
  static fromPersisted(amount: string, currency: string): Money {
    return new Money(parseCents(amount, currency, PERSISTED_AMOUNT), currency);
  }

  static zero(currency: string): Money {
    return Money.fromPersisted("0.00", currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  get amount(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${whole}.${frac}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
