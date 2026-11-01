import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from "../shared/domain-error";
import { LedgerDirection } from "../wagering/enums";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("initial balance cannot be negative");
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência; não revalida nada. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(p: WalletMovement): WalletLedgerEntry {
    this.assertMovable(p.money);
    if (this._balance.isLessThan(p.money)) {
      throw new InsufficientFundsError(
        `balance ${this._balance.amount} is lower than debit ${p.money.amount}`,
      );
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(p.money), p);
  }

  credit(p: WalletMovement): WalletLedgerEntry {
    this.assertMovable(p.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(p.money), p);
  }

  private assertMovable(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet is ${this.currency}, movement is ${money.currency}`);
    }
    if (!money.isPositive()) {
      throw new InvalidMoneyError("movement amount must be positive");
    }
  }

  /** Cria o lançamento antes de mutar: se `create` lançar, a wallet fica intacta. */
  private apply(direction: LedgerDirection, balanceAfter: Money, p: WalletMovement): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: p.entryId,
      walletId: this.id,
      transactionId: p.transactionId,
      direction,
      money: p.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: p.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = p.at;
    return entry;
  }
}
