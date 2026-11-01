import { types } from "pg";

const NUMERIC_OID = 1700;

/**
 * NUMERIC sempre chega como string, nunca como number: dinheiro não passa por ponto flutuante.
 * O `pg` já devolve string por padrão; registrar o parser torna a garantia explícita e
 * protege contra qualquer parser global que alguém instale depois.
 */
export function configureNumericAsString(): void {
  types.setTypeParser(NUMERIC_OID, (value: string) => value);
}

configureNumericAsString();
