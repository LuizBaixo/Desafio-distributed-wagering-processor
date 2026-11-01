export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca vem da API nem da fila. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = "PENDING",
  /** Aguardando a transação referenciada. */
  PendingReference = "PENDING_REFERENCE",
  /** Aplicada (terminal). */
  Processed = "PROCESSED",
  /** Violação de regra de negócio (terminal). */
  Rejected = "REJECTED",
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = "FAILED",
}
