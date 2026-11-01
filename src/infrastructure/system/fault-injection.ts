export const FAULT_INJECTION = Symbol("FAULT_INJECTION");

export interface FaultInjectionOptions {
  /** Valor de FAULT_INJECT. */
  mode?: string | undefined;
  /** Valor de NODE_ENV. A injeção só vale com "test". */
  nodeEnv?: string | undefined;
  exit?: (code: number) => never;
}

/**
 * Pontos de injeção de falha para os testes de crash. Inativo fora de `NODE_ENV=test`, mesmo que
 * FAULT_INJECT esteja definido: produção nunca se mata por engano de configuração.
 */
export class FaultInjection {
  private readonly active: boolean;
  private readonly exit: (code: number) => never;

  constructor(opts: FaultInjectionOptions = {}) {
    const mode = "mode" in opts ? opts.mode : process.env.FAULT_INJECT;
    const nodeEnv = "nodeEnv" in opts ? opts.nodeEnv : process.env.NODE_ENV;
    this.active = nodeEnv === "test" && mode === "exit_after_commit";
    this.exit = opts.exit ?? ((code) => process.exit(code));
  }

  /** Chamado entre o commit (use case resolvido) e o ack. Com a falha ativa, mata o processo (137). */
  afterCommit(): void {
    if (this.active) this.exit(137);
  }
}
