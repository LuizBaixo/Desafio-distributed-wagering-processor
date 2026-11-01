export type ExclusiveResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Exclusão mútua entre instâncias. `runExclusive` roda `work` só se esta instância conseguir o lock de
 * `name`; quem não consegue devolve `{ acquired: false }` sem esperar. O lock dura o `work` inteiro e é
 * liberado no fim, inclusive quando `work` lança.
 */
export interface ExclusiveRunner {
  runExclusive<T>(name: string, work: () => Promise<T>): Promise<ExclusiveResult<T>>;
}

export const EXCLUSIVE_RUNNER = Symbol("EXCLUSIVE_RUNNER");
