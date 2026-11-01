import type { FailureCode } from "../../domain/wagering/failure-code";
import type { WagerTransactionStatus } from "../../domain/wagering/enums";
import type { MoneyProps } from "../../domain/money/money";

export type WagerResultView = {
  transactionId: string | null;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
};

export type WagerOutcome =
  | { kind: "processed"; view: WagerResultView }
  | { kind: "rejected"; view: WagerResultView }
  | { kind: "pending"; view: WagerResultView }
  | { kind: "conflict"; code: "IDEMPOTENCY_CONFLICT" | "EXTERNAL_ID_CONFLICT" };
