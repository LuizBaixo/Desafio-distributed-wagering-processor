import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import {
  ConcurrencyViolationError,
  DuplicateWalletError,
  ForbiddenError,
  InvalidPayloadError,
  NotFoundError,
  TransientInfrastructureError,
  UnauthorizedError,
} from "../../application/errors";
import { InvalidMoneyError } from "../../domain/shared/domain-error";

/** Subconjunto de Express Response usado aqui; evita depender de @types/express. */
interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** Subconjunto do logger pino usado pelo filtro. */
export interface ErrorLogger {
  error(obj: object, msg?: string): void;
}

export const ERROR_LOGGER = Symbol("ERROR_LOGGER");

interface Mapped {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

/**
 * Mapeamento de erros para HTTP (formato `{ error: { code, message } }`).
 * Lista fechada conforme a Tarefa 8; o restante vira 500 INTERNAL sem vazar a mensagem.
 */
function map(exception: unknown): Mapped {
  if (exception instanceof InvalidPayloadError) {
    return { status: 400, code: exception.code, message: exception.message };
  }
  if (exception instanceof UnauthorizedError) {
    return { status: 401, code: exception.code, message: exception.message };
  }
  if (exception instanceof ForbiddenError) {
    return { status: 403, code: exception.code, message: exception.message };
  }
  if (exception instanceof InvalidMoneyError) {
    return { status: 400, code: "INVALID_MONEY", message: exception.message };
  }
  if (exception instanceof NotFoundError) {
    return { status: 404, code: "NOT_FOUND", message: exception.message };
  }
  if (exception instanceof DuplicateWalletError) {
    return { status: 409, code: "WALLET_ALREADY_EXISTS", message: exception.message };
  }
  // Conflito de versão é transitório (Design §7): mesma resposta que falha de infraestrutura.
  if (exception instanceof TransientInfrastructureError || exception instanceof ConcurrencyViolationError) {
    return {
      status: 503,
      code: "INFRA_UNAVAILABLE",
      message: exception.message,
      retryAfterSeconds: 1,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = status === 400 ? "INVALID_PAYLOAD" : status === 404 ? "NOT_FOUND" : "HTTP_ERROR";
    return { status, code, message: exception.message };
  }
  return { status: 500, code: "INTERNAL", message: "internal error" };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(ERROR_LOGGER) private readonly logger: ErrorLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponseLike>();
    const mapped = map(exception);
    if (mapped.code === "INTERNAL") {
      // Só nome e stack: nunca o body da request.
      const err = exception instanceof Error ? exception : undefined;
      this.logger.error(
        { errorName: err?.name ?? "UnknownError", stack: err?.stack },
        "unhandled error",
      );
    }
    if (mapped.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(mapped.retryAfterSeconds));
    }
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
  }
}
