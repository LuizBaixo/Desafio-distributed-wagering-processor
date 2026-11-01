# Distributed Wagering Processor

Serviço financeiro que processa transações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores, por HTTP e SQS. Correto com mensagens duplicadas, fora de ordem e concorrentes, com várias instâncias.

Decisões de arquitetura, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

**Decisões e trade-offs:** ver [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x (testado com 1.4.4)
- Docker com Compose v2 (testado com Docker 29.9.2)

Não é preciso conta em nenhum serviço externo: o SQS roda localmente com [MiniStack](https://github.com/ministackorg/ministack) (imagem `ministackorg/ministack:1.5.35`), que não exige token.

## Setup

```bash
bun install
cp .env.example .env   # opcional: os valores padrão já apontam para o compose local
```

## Subir a stack local (3 instâncias)

```bash
docker compose up -d --build --scale app=3
```

Sobe `postgres` (5432), `ministack` (4566), `sqs-init` (cria as filas e sai), `migrate` (roda as migrations como dono do schema e sai) e três instâncias da aplicação, expostas em `3001`, `3002` e `3003`. Cada instância roda com `APP_ROLES=api,consumer,outbox,pending`.

```bash
curl localhost:3001/health/live
curl localhost:3002/health/live
curl localhost:3003/health/live
```

Portas do host (padrão entre parênteses), configuráveis por variável de ambiente ou no `.env`:

- `POSTGRES_PORT` (`5432`)
- `SQS_PORT` (`4566`)
- `APP_PORTS` (`3001-3003`): uma porta por réplica; ao mudar, informe um intervalo do mesmo tamanho do `--scale`

Exemplo: `POSTGRES_PORT=55432 APP_PORTS=3011-3013 docker compose up -d --build --scale app=3`.

Essas portas podem colidir com um Postgres ou LocalStack que já esteja rodando na máquina (erro `port is already allocated`). Nesse caso, escolha outra porta. Se for rodar a aplicação fora do compose, aponte `DATABASE_URL` e `SQS_ENDPOINT` para a porta escolhida.

Para parar: `docker compose down -v`.

## Scripts

| Script | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação (`src/main.ts`), conforme `APP_ROLES` e as variáveis de ambiente |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test:unit` | Testes unitários (`test/unit`), sem banco nem SQS |
| `bun run test:integration` | Testes de integração contra PostgreSQL e MiniStack de teste |
| `bun run test:concurrency` | Testes de concorrência com processos reais (`test/concurrency`) |
| `bun run test` | Os três acima, em sequência |
| `bun run migration:up` | Aplica as migrations (usa `MIGRATION_DATABASE_URL`, senão `DATABASE_URL`, senão o owner de teste em `localhost:5433`) |
| `bun run migration:down` | Reverte as migrations |
| `bun run infra:test:up` | Sobe a infra de teste (`docker-compose.test.yml`): Postgres em `5433`, MiniStack em `4567` |
| `bun run infra:test:down` | Derruba a infra de teste e remove os volumes |

## Infra de teste e isolamento entre agentes

Antes de qualquer teste de integração ou concorrência:

```bash
bun run infra:test:up
```

Variáveis que os testes aceitam:

- `TEST_DB_NAME` (padrão `wagering`): nome do banco de teste. Cada agente usa o seu para não derrubar os dados dos outros:
  ```bash
  TEST_DB_NAME=wagering_faisca bun run test:integration
  ```
  Se o banco não existir, o helper `ensureTestDatabase()` cria com dono `wagering_owner`.
- `TEST_PORT_BASE` (padrão `4101`): porta base dos processos criados pelos testes de concorrência. Use outro valor para rodar dois agentes ao mesmo tempo:
  ```bash
  TEST_PORT_BASE=4201 TEST_DB_NAME=wagering_forja bun run test:concurrency
  ```

Com a infra de teste no ar, `bun run test` roda tudo. Para encerrar: `bun run infra:test:down`.

## Endpoints

Todos os exemplos usam a instância em `localhost:3001`. Dinheiro é sempre `{ "amount": "25.00", "currency": "BRL" }`: string decimal com exatamente 2 casas.

### Criar wallet

```bash
curl -X POST localhost:3001/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Resposta `201`: `{"id","playerId","balance","version"}`. Saldo maior que zero gera a transação `OPENING` e o lançamento `CREDIT` na mesma transação SQL. Mesmo `playerId` + moeda de novo dá `409 WALLET_ALREADY_EXISTS`.

### Consultar wallet

```bash
curl localhost:3001/wallets/<walletId>
```

### Ledger (paginado por cursor)

```bash
curl "localhost:3001/wallets/<walletId>/ledger?limit=50"
curl "localhost:3001/wallets/<walletId>/ledger?limit=50&cursor=<nextCursor>"
```

`limit` vai até 200. O cursor é opaco. `nextCursor` é `null` na última página. Cursor adulterado dá `400 INVALID_PAYLOAD`.

### Submeter transação de aposta

```bash
curl -X POST localhost:3001/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Status HTTP: `200` processada (`PROCESSED`), `202` pendente de referência (`PENDING_REFERENCE`), `422` rejeitada por regra de negócio (com `failureCode`), `409` conflito de idempotência ou de `externalTransactionId`, `400` payload inválido, `503` falha transitória (com `Retry-After`). Repetir a mesma requisição devolve o resultado original com `"idempotentReplay": true`.

Para `REFUND` e `ROLLBACK`, envie também `"referenceExternalTransactionId": "<externalTransactionId da BET>"`.

### Consultar transação

```bash
curl localhost:3001/wagering/transactions/<transactionId>
curl localhost:3001/providers/provider-a/wagering/transactions/transaction-123
```

### Reconciliação

```bash
curl -X POST localhost:3001/wallets/<walletId>/reconciliation
```

Compara o saldo guardado com o ledger e responde `consistent`, `difference` e `checkedEntries`. Divergência não é corrigida: é logada e contada em `reconciliation_mismatches_total`.

### Health e métricas

```bash
curl localhost:3001/health/live     # processo vivo
curl localhost:3001/health/ready    # PostgreSQL e SQS alcançáveis
curl localhost:3001/metrics         # Prometheus
```

`/health/ready` faz `SELECT 1` no PostgreSQL e `GetQueueAttributes` na fila principal; se qualquer um falhar, responde `503`.

### Mensagens SQS

O papel `consumer` lê `wager-transactions.fifo` e processa pelo mesmo caso de uso do HTTP. Exemplo de envio:

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Depois do processamento, os eventos aparecem em `wallet-events.fifo`:

```bash
aws --endpoint-url http://localhost:4566 sqs receive-message \n  --queue-url http://localhost:4566/000000000000/wallet-events.fifo --max-number-of-messages 10
```

Credenciais do MiniStack: qualquer valor (`AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`).

## Configuração

Variáveis lidas por `src/config/config.ts` (valores padrão entre parênteses):

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | obrigatória | Conexão do runtime (papel `wagering_app`) |
| `MIGRATION_DATABASE_URL` | `DATABASE_URL` | Conexão de migrations (papel `wagering_owner`) |
| `SQS_ENDPOINT` | obrigatória | Endpoint SQS (MiniStack) |
| `AWS_REGION` | `us-east-1` | Região |
| `APP_ROLES` | `api` | Papéis ativos: `api,consumer,outbox,pending` |
| `WAGER_QUEUE_NAME` | `wager-transactions.fifo` | Fila de entrada |
| `WAGER_DLQ_NAME` | `wager-transactions-dlq.fifo` | DLQ |
| `WALLET_EVENTS_QUEUE_NAME` | `wallet-events.fifo` | Fila de eventos da outbox |
| `PENDING_MAX_ATTEMPTS` | `10` | Tentativas do worker de pendentes antes de `REFERENCE_NOT_FOUND` |
| `PENDING_POLL_MS` | `1000` | Intervalo do worker de pendentes |
| `OUTBOX_POLL_MS` | `500` | Intervalo do publicador da outbox |
| `CONSUMER_CONCURRENCY` | `5` | Mensagens em paralelo por instância |
| `SHUTDOWN_GRACE_MS` | `20000` | Tempo para terminar mensagens em andamento no `SIGTERM` |
| `CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | `30` | VisibilityTimeout do consumidor |
| `CONSUMER_MAX_BACKOFF_SECONDS` | `60` | Teto do backoff de retry |
| `CONSUMER_WAIT_SECONDS` | `10` | Long polling |

`.env.example` traz os valores do compose local.

## Estrutura

```
src/
  domain/          # regras puras: Money, Wallet, WagerTransaction, decideWager, eventos
  application/     # casos de uso e portas (UnitOfWork, repositórios, Clock, IdGenerator, Metrics)
  infrastructure/  # MikroORM, repositórios SQL, SQS, observabilidade
  interfaces/      # controllers HTTP, consumidor SQS, workers (outbox, pendentes)
test/
  unit/            # domínio e aplicação, sem I/O
  integration/     # PostgreSQL e MiniStack reais
  concurrency/     # processos reais em paralelo
infra/
  postgres/init-roles.sql    # papéis wagering_owner e wagering_app
  ministack/init-sqs.sh      # filas FIFO, DLQ e RedrivePolicy (maxReceiveCount 5)
```
