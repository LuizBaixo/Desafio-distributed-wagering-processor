import { describe, expect, test } from "bun:test";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { HttpErrorFilter, type ErrorLogger } from "../../../src/interfaces/http/http-error.filter";
import {
  ConcurrencyViolationError,
  DuplicateWalletError,
  InvalidPayloadError,
  NotFoundError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
} from "../../../src/application/errors";
import { InvalidMoneyError } from "../../../src/domain/shared/domain-error";

interface Captured {
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
  logged: Array<{ obj: object; msg?: string }>;
}

function run(error: unknown): Captured {
  const captured: Captured = { headers: {}, logged: [] };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  const logger: ErrorLogger = {
    error(obj, msg) {
      captured.logged.push({ obj, ...(msg !== undefined ? { msg } : {}) });
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }),
  };
  new HttpErrorFilter(logger).catch(error, host as never);
  return captured;
}

const codeOf = (r: Captured): string => (r.body as { error: { code: string } }).error.code;

describe("HttpErrorFilter", () => {
  test("TransientInfrastructureError vira 503 com Retry-After: 1", () => {
    const r = run(new TransientInfrastructureError("pg down"));
    expect(r.status).toBe(503);
    expect(r.headers["Retry-After"]).toBe("1");
    expect(r.body).toEqual({ error: { code: "INFRA_UNAVAILABLE", message: "pg down" } });
  });

  test("InvalidMoneyError vira 400 com code INVALID_MONEY", () => {
    const r = run(new InvalidMoneyError("amount must be a decimal string"));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: { code: "INVALID_MONEY", message: "amount must be a decimal string" },
    });
  });

  test("InvalidPayloadError vira 400 com o code da própria exceção", () => {
    const r = run(new InvalidPayloadError("kind OPENING", "KIND_NOT_ALLOWED"));
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("KIND_NOT_ALLOWED");
  });

  test("NotFoundError vira 404", () => {
    const r = run(new NotFoundError("wager transaction not found"));
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("NOT_FOUND");
  });

  test("DuplicateWalletError vira 409 WALLET_ALREADY_EXISTS", () => {
    const r = run(new DuplicateWalletError());
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("WALLET_ALREADY_EXISTS");
  });

  test("erro genérico vira 500 INTERNAL sem vazar a mensagem", () => {
    const r = run(new Error("password=hunter2 in connection string"));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
  });

  test("PermanentInfrastructureError continua 500 INTERNAL", () => {
    const r = run(new PermanentInfrastructureError());
    expect(r.status).toBe(500);
    expect(codeOf(r)).toBe("INTERNAL");
  });

  test("ConcurrencyViolationError vira 503 INFRA_UNAVAILABLE com Retry-After: 1", () => {
    const r = run(new ConcurrencyViolationError());
    expect(r.status).toBe(503);
    expect(r.headers["Retry-After"]).toBe("1");
    expect(codeOf(r)).toBe("INFRA_UNAVAILABLE");
  });

  test("HttpException 400 (ParseUUIDPipe, JSON malformado) vira INVALID_PAYLOAD", () => {
    const r = run(new BadRequestException("Validation failed (uuid is expected)"));
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("INVALID_PAYLOAD");
  });

  test("HttpException 404 vira NOT_FOUND", () => {
    const r = run(new NotFoundException("Cannot GET /nope"));
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("NOT_FOUND");
  });

  test("outros status de HttpException mantêm HTTP_ERROR", () => {
    const r = run(new ConflictException("conflict"));
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("HTTP_ERROR");
  });

  test("todo 500 INTERNAL é logado em error com nome e stack", () => {
    const err = new Error("boom");
    const r = run(err);
    expect(r.logged).toHaveLength(1);
    const entry = r.logged[0]!;
    expect(entry.obj).toEqual({ errorName: "Error", stack: err.stack });
  });

  test("o log de 500 não contém body da request", () => {
    const r = run(new Error("boom"));
    expect(Object.keys(r.logged[0]!.obj).sort()).toEqual(["errorName", "stack"]);
  });

  test("respostas que não são 500 não são logadas pelo filtro", () => {
    const r = run(new TransientInfrastructureError("pg down"));
    expect(r.logged).toHaveLength(0);
  });
});
