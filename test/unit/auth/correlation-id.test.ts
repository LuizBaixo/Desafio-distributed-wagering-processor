import { describe, expect, test } from "bun:test";
import { safeCorrelationId } from "../../../src/interfaces/http/correlation-id";

describe("safeCorrelationId", () => {
  test("aceita o formato permitido e devolve o mesmo valor", () => {
    for (const ok of ["abc", "A1._:-z", "x".repeat(128), "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1"]) {
      expect(safeCorrelationId(ok)).toBe(ok);
    }
  });

  test("valor inválido é descartado e substituído por um UUID novo, nunca refletido", () => {
    for (const bad of ["", "x".repeat(129), "a b", "a\nb", "<script>", "á", "a/b"]) {
      const out = safeCorrelationId(bad);
      expect(out).not.toBe(bad);
      expect(out).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("ausente gera UUID", () => {
    expect(safeCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
