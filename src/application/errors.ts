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
