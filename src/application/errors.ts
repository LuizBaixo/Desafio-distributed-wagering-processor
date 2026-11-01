export type InvalidPayloadCode = "INVALID_PAYLOAD" | "KIND_NOT_ALLOWED";

/** Payload de entrada inválido (HTTP 400 ou mensagem permanente). Formato igual ao de DomainError. */
export class InvalidPayloadError extends Error {
  readonly code: InvalidPayloadCode;

  constructor(message: string, code: InvalidPayloadCode = "INVALID_PAYLOAD") {
    super(message);
    this.name = "InvalidPayloadError";
    this.code = code;
  }
}

/** Falha transitória de infraestrutura (Postgres ou SQS indisponível, lock_timeout). HTTP 503 com Retry-After. */
export class TransientInfrastructureError extends Error {
  readonly code = "INFRA_UNAVAILABLE";

  constructor(message = "transient infrastructure failure") {
    super(message);
    this.name = "TransientInfrastructureError";
  }
}

/** Falha permanente de infraestrutura. */
export class PermanentInfrastructureError extends Error {
  readonly code = "INFRA_PERMANENT";

  constructor(message = "permanent infrastructure failure") {
    super(message);
    this.name = "PermanentInfrastructureError";
  }
}

/** Wallet já existe para o mesmo playerId + currency. HTTP 409. */
export class DuplicateWalletError extends Error {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(message = "wallet already exists for this player and currency") {
    super(message);
    this.name = "DuplicateWalletError";
  }
}

/** Violação de controle otimista (version não bate). Tratada como transitória no Design §7. */
export class ConcurrencyViolationError extends Error {
  readonly code = "CONCURRENCY_VIOLATION";

  constructor(message = "concurrent update detected") {
    super(message);
    this.name = "ConcurrencyViolationError";
  }
}

/** Recurso não encontrado em consulta. HTTP 404. */
export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(message = "resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}
