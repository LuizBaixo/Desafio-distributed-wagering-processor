import type { IdGenerator } from "../../application/ports/id-generator";

/** UUID v7 (ordenável no tempo) via runtime do Bun; sem dependência extra. */
export class Uuid7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
