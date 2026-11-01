import { describe, expect, test } from "bun:test";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { WalletCreated } from "../../../src/domain/events/events";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { Money } from "../../../src/domain/money/money";

const t0 = new Date("2026-10-31T00:00:00.000Z");
const wallet = Wallet.open({
  id: "w1",
  playerId: "p1",
  initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
  at: t0,
});

function outbox() {
  const event = WalletCreated.from(wallet, {
    eventId: "evt-1",
    correlationId: "corr-1",
    occurredAt: t0,
  });
  return OutboxMessage.enqueue(event);
}

describe("OutboxMessage.enqueue", () => {
  test("id é o eventId, payload é o envelope e começa sem tentativas", () => {
    const m = outbox();
    expect(m.id).toBe("evt-1");
    expect(m.eventType).toBe("WalletCreated");
    expect(m.aggregateId).toBe("w1");
    expect(m.attempts).toBe(0);
    expect(m.nextAttemptAt?.getTime()).toBe(t0.getTime());
    expect(m.payload).toMatchObject({ eventId: "evt-1", eventType: "WalletCreated" });
    expect(m.isPending()).toBe(true);
  });
});

describe("OutboxMessage.scheduleRetry", () => {
  test("três retries: attempts 3 e nextAttemptAt = now + 4s", () => {
    const m = outbox();
    const now = new Date("2026-10-31T01:00:00.000Z");
    m.scheduleRetry(now);
    m.scheduleRetry(now);
    m.scheduleRetry(now);
    expect(m.attempts).toBe(3);
    expect(m.nextAttemptAt?.getTime()).toBe(now.getTime() + 4_000);
  });

  test("backoff tem teto de 300 segundos", () => {
    const m = outbox();
    const now = new Date("2026-10-31T01:00:00.000Z");
    for (let i = 0; i < 12; i++) m.scheduleRetry(now);
    expect(m.nextAttemptAt?.getTime()).toBe(now.getTime() + 300_000);
  });
});

describe("OutboxMessage.isDue / markPublished", () => {
  test("isDue é false quando nextAttemptAt > now", () => {
    const m = outbox();
    m.scheduleRetry(t0); // próximo em t0 + 1s
    expect(m.isDue(t0)).toBe(false);
    expect(m.isDue(new Date(t0.getTime() + 1_000))).toBe(true);
  });

  test("markPublished torna a mensagem não pendente", () => {
    const m = outbox();
    m.markPublished(t0);
    expect(m.publishedAt).toEqual(t0);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date(t0.getTime() + 1e9))).toBe(false);
  });
});
