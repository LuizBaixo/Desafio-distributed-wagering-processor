import { describe, expect, test } from "bun:test";
import { InvalidPayloadError } from "../../../src/application/errors";
import { decodeCursor, encodeCursor } from "../../../src/interfaces/http/cursor";

describe("cursor do ledger", () => {
  test("encodeCursor é base64url de 'v1:{seq}'", () => {
    expect(encodeCursor(5n)).toBe(Buffer.from("v1:5").toString("base64url"));
  });

  test("decode devolve o seq original (ida e volta)", () => {
    expect(decodeCursor(encodeCursor(1n))).toBe(1n);
    expect(decodeCursor(encodeCursor(120n))).toBe(120n);
  });

  test("cursor adulterado ('abc!!') lança InvalidPayloadError", () => {
    expect(() => decodeCursor("abc!!")).toThrow(InvalidPayloadError);
  });

  test("payload válido em base64url mas com outro formato lança InvalidPayloadError", () => {
    for (const raw of ["v2:5", "v1:-1", "v1:05", "v1:", "hello"]) {
      expect(() => decodeCursor(Buffer.from(raw).toString("base64url"))).toThrow(InvalidPayloadError);
    }
  });
});
