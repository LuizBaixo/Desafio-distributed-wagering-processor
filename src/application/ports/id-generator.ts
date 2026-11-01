/** Gera ids únicos ordenáveis no tempo (UUID v7). */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol("ID_GENERATOR");
