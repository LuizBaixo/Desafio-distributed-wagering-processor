import { describe, expect, spyOn, test } from "bun:test";
import { Client } from "pg";
import { PgAdvisoryLock } from "../../../src/infrastructure/persistence/pg-advisory-lock";

describe("PgAdvisoryLock: falha de conexão", () => {
  test("connect contra porta fechada falha em menos de 6 s e o client é encerrado", async () => {
    const endSpy = spyOn(Client.prototype, "end");
    try {
      const lock = new PgAdvisoryLock("postgres://wagering_app:app@127.0.0.1:1/wagering");
      const started = performance.now();

      await expect(lock.runExclusive("reconciliation", async () => "never")).rejects.toThrow();

      expect(performance.now() - started).toBeLessThan(6000);
      expect(endSpy).toHaveBeenCalled();
    } finally {
      endSpy.mockRestore();
    }
  });
});
