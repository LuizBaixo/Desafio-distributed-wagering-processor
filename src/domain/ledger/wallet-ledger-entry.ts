import { Money } from "../money/money";
import { UnbalancedLedgerEntryError } from "../shared/domain-error";
import { LedgerDirection } from "../wagering/enums";

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
  /** Preenchido só na reidratação (BIGSERIAL do banco). */
  seq?: bigint;
}

export type CreateLedgerEntryProps = Omit<LedgerEntryState, "seq">;

/** Imutável: só campos readonly, sem setters nem métodos de transição. */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
    readonly seq?: bigint,
  ) {}

  /** Valida a aritmética: `balanceBefore ± money === balanceAfter`, valor positivo, moeda única. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new UnbalancedLedgerEntryError("ledger entry mixes currencies");
    }
    if (!money.isPositive()) {
      throw new UnbalancedLedgerEntryError("ledger entry amount must be positive");
    }
    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${props.direction} ${money.amount}: ${balanceBefore.amount} -> ${balanceAfter.amount} is not balanced`,
      );
    }
    return entry;
  }

  /** Reconstrói estado persistido; não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id,
      s.walletId,
      s.transactionId,
      s.direction,
      s.money,
      s.balanceBefore,
      s.balanceAfter,
      s.createdAt,
      s.seq,
    );
  }
}
