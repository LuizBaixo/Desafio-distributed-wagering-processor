import type { WagerCommand } from "../../src/application/wagering/wager-command";

export interface WagerResponse {
  status: number;
  headers: Headers;
  body: any;
}

/** POST /wagering/transactions. A `Idempotency-Key` sai do comando e não vai no corpo. */
export async function postWager(
  baseUrl: string,
  cmd: WagerCommand,
  opts: { key?: string | null; headers?: Record<string, string> } = {},
): Promise<WagerResponse> {
  const { idempotencyKey, ...body } = cmd;
  const key = opts.key === undefined ? idempotencyKey : opts.key;
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key !== null ? { "idempotency-key": key } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

export async function getJson(baseUrl: string, path: string): Promise<WagerResponse> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, headers: res.headers, body: await res.json() };
}
