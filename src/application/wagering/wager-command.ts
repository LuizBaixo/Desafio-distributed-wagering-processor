import { z } from "zod";
import { InvalidPayloadError } from "../errors";
import { Money, type MoneyProps } from "../../domain/money/money";
import { InvalidMoneyError } from "../../domain/shared/domain-error";
import { WagerTransactionKind } from "../../domain/wagering/enums";

export type WagerCommand = {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KINDS = ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] as const;
const REFERENCE_REQUIRED = new Set(["REFUND", "ROLLBACK"]);

const nonEmpty128 = z.string().min(1).max(128);

const bodySchema = z
  .strictObject({
    providerId: nonEmpty128,
    externalTransactionId: nonEmpty128,
    playerId: z.string().regex(UUID),
    walletId: z.string().regex(UUID),
    roundId: nonEmpty128,
    gameId: nonEmpty128,
    kind: z.string(),
    // Validado depois por Money.from, para que amount não-string vire INVALID_MONEY e não INVALID_PAYLOAD.
    money: z.strictObject({ amount: z.unknown(), currency: z.unknown() }),
    referenceExternalTransactionId: nonEmpty128.optional(),
  })
  .superRefine((body, ctx) => {
    if (REFERENCE_REQUIRED.has(body.kind) && body.referenceExternalTransactionId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: `${body.kind} requires referenceExternalTransactionId`,
      });
    }
  });

/**
 * Valida o corpo HTTP ou a mensagem SQS e devolve o comando.
 * Erros: InvalidPayloadError (INVALID_PAYLOAD ou KIND_NOT_ALLOWED) e InvalidMoneyError (INVALID_MONEY).
 */
export function parseWagerCommand(body: unknown, idempotencyKey: string | undefined): WagerCommand {
  if (
    idempotencyKey === undefined ||
    idempotencyKey.length === 0 ||
    idempotencyKey !== idempotencyKey.trim() ||
    idempotencyKey.length > 255
  ) {
    throw new InvalidPayloadError("Idempotency-Key is required (1-255 chars, no outer spaces)");
  }

  const kindRaw = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["kind"] : undefined;
  if (kindRaw === WagerTransactionKind.Opening) {
    throw new InvalidPayloadError("OPENING is internal and cannot be submitted", "KIND_NOT_ALLOWED");
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    throw new InvalidPayloadError(`invalid payload: ${details}`);
  }
  const data = parsed.data;

  if (!(ALLOWED_KINDS as readonly string[]).includes(data.kind)) {
    throw new InvalidPayloadError(`kind must be one of ${ALLOWED_KINDS.join(", ")}`);
  }

  const money = Money.from({
    amount: data.money.amount as string,
    currency: data.money.currency as string,
  });
  if (money.isZero()) {
    throw new InvalidMoneyError("money amount must be greater than zero");
  }

  return {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind as WagerCommand["kind"],
    money: money.toJSON(),
    ...(data.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
      : {}),
  };
}
