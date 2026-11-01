export interface QueueMessage {
  body: string;
  receiptHandle: string;
  /** `ApproximateReceiveCount` do SQS: quantas vezes esta mensagem já foi entregue (>= 1). */
  receiveCount: number;
  /** Id da mensagem atribuído pelo SQS (não confundir com o `messageId` do envelope). */
  messageId: string;
  /** Atributos de mensagem (String) que o adaptador pediu no receive; hoje só `traceparent`. */
  attributes?: Record<string, string>;
}

export interface SendOptions {
  groupId: string;
  dedupId: string;
  attributes?: Record<string, string>;
}

export interface BatchEntry {
  /** Identifica a entrada no resultado (o chamador escolhe; o adaptador mapeia de volta). */
  id: string;
  body: string;
  groupId: string;
  dedupId: string;
  attributes?: Record<string, string>;
}

export interface BatchResult {
  ok: string[];
  failed: Array<{ id: string; code: string }>;
}

/** Porta de fila. `queue` é o nome da fila (ex.: `wager-transactions.fifo`); a URL é resolvida por dentro. */
export interface QueuePort {
  /** Long polling de até `waitSeconds`. Não há cancelamento: abortar um receive no cliente pode deixar a mensagem invisível no servidor. */
  receive(queue: string, max: number, waitSeconds: number): Promise<QueueMessage[]>;
  delete(queue: string, receiptHandle: string): Promise<void>;
  changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void>;
  send(queue: string, body: string, opts: SendOptions): Promise<void>;
  /**
   * Envia até 10 entradas em uma chamada. Falha parcial não lança: as entradas rejeitadas voltam em
   * `failed`. Mais de 10 entradas lança `Error`; quem divide em lotes é o chamador. Entrada com corpo
   * acima de 256 KiB vira `failed` com `BODY_TOO_LARGE`, sem ser enviada. Lança se a chamada inteira falha.
   */
  sendBatch(queue: string, entries: BatchEntry[]): Promise<BatchResult>;
  /** Falha (lança) se a fila principal não responde; usada pelo /health/ready. */
  ping(): Promise<void>;
}

export const QUEUE_PORT = Symbol("QUEUE_PORT");
