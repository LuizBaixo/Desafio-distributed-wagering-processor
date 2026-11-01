import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { UnitOfWork } from "../ports/unit-of-work";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { OutboxMessage as Outbox } from "../../domain/messaging/outbox-message";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { Money, type MoneyProps } from "../../domain/money/money";
import { LedgerDirection, WagerTransactionKind } from "../../domain/wagering/enums";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletCreated, WalletBalanceChanged, WagerTransactionProcessed } from "../../domain/events/events";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import { wagerPayloadHash } from "../idempotency/payload-hash";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletContext {
  correlationId: string;
}

const OPENING_PROVIDER = "internal";
const OPENING_ROUND = "opening";

/**
 * Cria a wallet. Com saldo > 0, grava também a transação OPENING e o lançamento CREDIT,
 * tudo em uma única transação SQL, junto com os eventos da outbox.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateWalletInput, ctx: CreateWalletContext): Promise<WalletView> {
    const initial = Money.from(input.initialBalance);
    const playerId = input.playerId.toLowerCase();
    const now = this.clock.now();
    const walletId = this.ids.next();
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initial, at: now });

    const eventCtx = () => ({ eventId: this.ids.next(), correlationId: ctx.correlationId, occurredAt: now });

    await this.uow.run(async (scope) => {
      await scope.wallets.insert(wallet);
      const events: IntegrationEvent<unknown>[] = [];

      if (initial.isPositive()) {
        const txId = this.ids.next();
        const external = `opening:${walletId}`;
        const tx = WagerTransaction.createOpening({
          id: txId,
          providerId: OPENING_PROVIDER,
          externalTransactionId: external,
          idempotencyKey: external,
          payloadHash: wagerPayloadHash({
            providerId: OPENING_PROVIDER,
            externalTransactionId: external,
            playerId,
            walletId,
            roundId: OPENING_ROUND,
            gameId: OPENING_ROUND,
            kind: WagerTransactionKind.Opening,
            money: initial.toJSON(),
          }),
          walletId,
          playerId,
          roundId: OPENING_ROUND,
          gameId: OPENING_ROUND,
          money: initial,
          createdAt: now,
        });
        tx.markProcessed(undefined, wallet.balance, now);
        await scope.transactions.insert(tx);

        const entry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId,
          transactionId: txId,
          direction: LedgerDirection.Credit,
          money: initial,
          balanceBefore: Money.zero(initial.currency),
          balanceAfter: wallet.balance,
          createdAt: now,
        });
        await scope.ledger.append(entry);

        events.push(WalletCreated.from(wallet, eventCtx()));
        events.push(WagerTransactionProcessed.from(tx, eventCtx()));
        events.push(WalletBalanceChanged.from(wallet, entry, eventCtx()));
      } else {
        events.push(WalletCreated.from(wallet, eventCtx()));
      }

      for (const event of events) {
        const message: OutboxMessage = Outbox.enqueue(event);
        await scope.outbox.enqueue(message);
      }
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
