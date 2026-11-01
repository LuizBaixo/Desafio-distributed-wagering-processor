import { describe, expect, test } from "bun:test";
import { HttpErrorFilter } from "../../../src/interfaces/http/http-error.filter";
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
}

function run(error: unknown): Captured {
  const captured: Captured = { headers: {} };
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
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }),
  };
  new HttpErrorFilter().catch(error, host as never);
  return captured;
}

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
    expect((r.body as { error: { code: string } }).error.code).toBe("KIND_NOT_ALLOWED");
  });

  test("NotFoundError vira 404", () => {
    const r = run(new NotFoundError("wager transaction not found"));
    expect(r.status).toBe(404);
    expect((r.body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  test("DuplicateWalletError vira 409 WALLET_ALREADY_EXISTS", () => {
    const r = run(new DuplicateWalletError());
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("erro genérico vira 500 INTERNAL sem vazar a mensagem", () => {
    const r = run(new Error("password=hunter2 in connection string"));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
  });

  test("PermanentInfrastructureError e ConcurrencyViolationError seguem a lista: 500 INTERNAL", () => {
    expect(run(new PermanentInfrastructureError()).status).toBe(500);
    expect(run(new ConcurrencyViolationError()).status).toBe(500);
  });
});
