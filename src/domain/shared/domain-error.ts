export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class KindNotAllowedError extends DomainError {
  readonly code = "KIND_NOT_ALLOWED";
}

export class MissingReferenceError extends DomainError {
  readonly code = "MISSING_REFERENCE";
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";
}
