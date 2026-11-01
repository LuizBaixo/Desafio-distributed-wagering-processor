import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import {
  DuplicateWalletError,
  InvalidPayloadError,
  NotFoundError,
  TransientInfrastructureError,
} from "../../application/errors";
import { InvalidMoneyError } from "../../domain/shared/domain-error";

/** Subconjunto de Express Response usado aqui; evita depender de @types/express. */
interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

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
  if (exception instanceof InvalidMoneyError) {
    return { status: 400, code: "INVALID_MONEY", message: exception.message };
  }
  if (exception instanceof NotFoundError) {
    return { status: 404, code: "NOT_FOUND", message: exception.message };
  }
  if (exception instanceof DuplicateWalletError) {
    return { status: 409, code: "WALLET_ALREADY_EXISTS", message: exception.message };
  }
  if (exception instanceof TransientInfrastructureError) {
    return {
      status: 503,
      code: "INFRA_UNAVAILABLE",
      message: exception.message,
      retryAfterSeconds: 1,
    };
  }
  if (exception instanceof HttpException) {
    return { status: exception.getStatus(), code: "HTTP_ERROR", message: exception.message };
  }
  return { status: 500, code: "INTERNAL", message: "internal error" };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponseLike>();
    const mapped = map(exception);
    if (mapped.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(mapped.retryAfterSeconds));
    }
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
  }
}
