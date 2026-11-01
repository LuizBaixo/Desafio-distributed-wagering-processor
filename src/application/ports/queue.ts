export interface QueueMessage {
  body: string;
  receiptHandle: string;
  /** `ApproximateReceiveCount` do SQS: quantas vezes esta mensagem já foi entregue (>= 1). */
  receiveCount: number;
  /** Id da mensagem atribuído pelo SQS (não confundir com o `messageId` do envelope). */
  messageId: string;
}

export interface SendOptions {
  groupId: string;
  dedupId: string;
  attributes?: Record<string, string>;
}

/** Porta de fila. `queue` é o nome da fila (ex.: `wager-transactions.fifo`); a URL é resolvida por dentro. */
export interface QueuePort {
  /** Long polling de até `waitSeconds`. Não há cancelamento: abortar um receive no cliente pode deixar a mensagem invisível no servidor. */
  receive(queue: string, max: number, waitSeconds: number): Promise<QueueMessage[]>;
  delete(queue: string, receiptHandle: string): Promise<void>;
  changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void>;
  send(queue: string, body: string, opts: SendOptions): Promise<void>;
  /** Falha (lança) se a fila principal não responde; usada pelo /health/ready. */
  ping(): Promise<void>;
}

export const QUEUE_PORT = Symbol("QUEUE_PORT");
