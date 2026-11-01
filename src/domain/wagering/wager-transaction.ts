import { Money } from "../money/money";
import {
  InvalidTransactionStateError,
  KindNotAllowedError,
  MissingReferenceError,
} from "../shared/domain-error";
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from "./enums";
import { FailureCode } from "./failure-code";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor, não o id interno. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

const S = WagerTransactionStatus;
const K = WagerTransactionKind;

/**
 * Máquina de estados (Design §10):
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (attempts + 1)
 *   PROCESSED, REJECTED, FAILED são terminais: qualquer transição lança InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _attempts: number = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. `OPENING` só entra por `createOpening`. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === K.Opening) {
      throw new KindNotAllowedError("OPENING is internal and cannot be submitted");
    }
    return WagerTransaction.build(props);
  }

  /** Usado só pelo `CreateWallet`. */
  static createOpening(props: Omit<CreateWagerTransactionProps, "kind">): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: K.Opening });
  }

  /** Reconstrói estado persistido; não revalida transições. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.attempts,
      s.nextAttemptAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = WagerTransaction.rehydrate({ ...props, status: S.Pending, attempts: 0 });
    if (tx.requiresReference() && !tx.hasReference()) {
      throw new MissingReferenceError(`${props.kind} requires referenceExternalTransactionId`);
    }
    return tx;
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, resultBalance: Money, at: Date): void {
    this.assertNotTerminal("markProcessed");
    this._status = S.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (this._status === S.PendingReference) {
      this._attempts += 1;
    }
    this._status = S.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, resultBalance: Money | undefined, at: Date): void {
    this.assertNotTerminal("reject");
    this._status = S.Rejected;
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = S.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return this._status === S.Processed || this._status === S.Rejected || this._status === S.Failed;
  }

  affectsBalance(): boolean {
    return this.kind !== K.Loss;
  }

  requiresReference(): boolean {
    return this.kind === K.Refund || this.kind === K.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET debita; WIN, REFUND e OPENING creditam; LOSS não movimenta (undefined).
   * ROLLBACK inverte a direção da transação referenciada.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case K.Bet:
        return LedgerDirection.Debit;
      case K.Win:
      case K.Refund:
      case K.Opening:
        return LedgerDirection.Credit;
      case K.Loss:
        return undefined;
      case K.Rollback: {
        if (!reference) {
          throw new MissingReferenceError("ROLLBACK needs the referenced transaction to derive direction");
        }
        const original = reference.ledgerDirectionFor();
        if (original === undefined) return undefined;
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${action} from terminal status ${this._status}`);
    }
  }
}
