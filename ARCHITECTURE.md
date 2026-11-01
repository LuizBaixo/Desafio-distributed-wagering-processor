# ARCHITECTURE

Decisões, trade-offs e limitações do Distributed Wagering Processor. Setup e comandos estão no [README](README.md).

**Status:** final. Todas as seções refletem o código no commit em que este arquivo foi fechado.

## 1. Camadas e portas

| Camada | Pasta | Conteúdo | Pode importar |
|---|---|---|---|
| Domínio | `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `decideWager`, erros de domínio | Só TypeScript puro |
| Aplicação | `src/application` | casos de uso (`CreateWallet`, `SubmitWagerTransaction`, `ReprocessPendingReferences`, `ReconcileWallet`), consultas, `WagerEngine`, portas | Domínio e portas |
| Infraestrutura | `src/infrastructure` | MikroORM, repositórios SQL, mapeadores, SQS, prom-client, pino | Aplicação e domínio |
| Interfaces | `src/interfaces` | controllers HTTP, filtro de erro, workers, consumidor SQS | Todas as anteriores |

**Regra de dependência.** `src/domain` não importa `@nestjs/*`, `@mikro-orm/*`, `pg` nem `@aws-sdk/*`. Os testes unitários de domínio rodam sem I/O.

**Portas** (`src/application/ports`):

- `UnitOfWork` e `TransactionScope`: cinco repositórios na mesma transação SQL (`wallets`, `transactions`, `ledger`, `inbox`, `outbox`). Implementação: `MikroUnitOfWork`.
- `Clock`, `IdGenerator` (UUID v7 via `Bun.randomUUIDv7()`), `Metrics`, `Logger`.
- Tokens de injeção em `ports/tokens.ts`. `PersistenceModule` é global e os fornece.

**Por que portas e não acesso direto.** Os casos de uso são testados com a infra real (requisito do desafio), mas a fronteira continua clara: quem decide regra é o domínio; quem grava é a infraestrutura; quem chama é a interface.

## 2. Processos e papéis

Uma imagem, um código. `APP_ROLES` (lista separada por vírgula, `api,consumer,outbox,pending`) decide o que cada processo liga:

- `api`: rotas HTTP.
- `consumer`: `WagerConsumer`, consumidor de `wager-transactions.fifo` (registrado pelo `MessagingModule`).
- `outbox`: `OutboxPublisher`, publica em `wallet-events.fifo` (registrado pelo `OutboxModule`).
- `pending`: `PendingReferenceWorker`, worker de referências pendentes.

Cada loop liga em `onApplicationBootstrap` só se o papel estiver em `APP_ROLES`, e para em `beforeApplicationShutdown`. O MikroORM fecha em `onApplicationShutdown`, que o Nest executa por último, então o trabalho em andamento termina com o banco ainda disponível. Antes, o ORM fechava em `onModuleDestroy`, que roda *antes* de `beforeApplicationShutdown`, e mensagens em andamento falhavam com `Unable to acquire a connection`.

Os testes sobem a aplicação com `APP_ROLES=api` por padrão. Os loops não ligam sozinhos nos testes de integração; eles chamam `tick()` diretamente. Os testes de concorrência sobem processos reais com os papéis necessários.

Compose local: `postgres`, `ministack`, `sqs-init` (cria as filas e sai), `migrate` (roda as migrations como `wagering_owner` e sai) e `app` escalável, com `APP_ROLES=api,consumer,outbox,pending`.

## 3. ORM e persistência

**Escolha: MikroORM 6.6.17**, com `@mikro-orm/postgresql` e `@mikro-orm/migrations`. Motivos: `EntityManager.transactional()` para a unidade de trabalho, `em.fork()` por operação, `Migrator` com transação, e pool de conexões gerenciado. Prisma e outros ORMs ficam fora do escopo do desafio.

**Atualização do Design §4.1: SQL explícito, sem `EntitySchema`.** O Design previa registros de persistência com `EntitySchema` e um mapper. Na implementação, o MikroORM é usado como conexão, transação e migrator, e o SQL é escrito à mão (`em.execute`, com a classe `Db` em `infrastructure/persistence/sql.ts`). Motivos:

- As garantias do desafio estão no banco: triggers de imutabilidade, índices únicos parciais, `CHECK` compostos, `FOR UPDATE SKIP LOCKED` e `LIMIT` em claim. Um `EntitySchema` não expressa isso sem SQL cru, e geraria dois lugares para manter.
- `NUMERIC` e `bigint` precisam de leitura exata como string. Com SQL explícito, o tipo de cada coluna é conhecido no ponto de leitura.
- O mapeamento fica num único lugar (`mappers.ts`): linha → `rehydrate`, e de volta para `INSERT`/`UPDATE`.

Migrations: uma migration (`Migration20261031000001_initial`), SQL escrito à mão, com `up` e `down`, `transactional: true`, lista explícita (`migrationsList`), sem varredura de arquivos. Verificado com `migration:down` e `migration:up` contra a infra de teste.

## 4. Dinheiro

- Domínio: `Money` guarda `bigint` em centavos e a moeda (ISO-4217). Operações são exatas. Nenhum `number`, `float` ou `parseFloat` em nenhuma camada, inclusive testes.
- Entrada: aceita só `^(0|[1-9]\d{0,17})\.\d{2}$`. Rejeita `NaN`, `Infinity`, notação científica, sinal negativo em contrato de entrada, mais de 2 casas, menos de 2 casas e zero (aposta precisa ser positiva). Valor com 19 dígitos inteiros dá `INVALID_MONEY`, porque não cabe em `NUMERIC(20,2)`.
- Banco: `NUMERIC(20,2)` mais `CHAR(3)` para a moeda. Um parser de tipo registrado no driver (`money.type.ts`, OID 1700) devolve string, nunca `number`.
- Persistido: `Money.fromPersisted` aceita sinal, porque o resultado de `subtract` pode ser negativo em cálculos internos (diferença da reconciliação).
- Multi-moeda no modelo; os cenários usam `BRL`; conflito de moeda é testado com `USD`.

## 5. Concorrência

**Unidade de concorrência: a wallet.** Toda alteração de saldo acontece em uma transação SQL que começa com `SELECT ... FOR UPDATE` na linha da wallet. A ordem de lock é sempre wallet, depois transação, então não há deadlock entre o caso síncrono e o worker de pendentes.

Camadas de defesa:

1. `FOR UPDATE` serializa por wallet. Wallets diferentes não disputam lock.
2. `UPDATE wallets ... WHERE id = $1 AND version = $2`. Zero linhas afetadas lança `ConcurrencyViolationError`, tratada como transitória.
3. `CHECK (balance >= 0)` no banco, a última barreira.
4. `SET LOCAL lock_timeout = '5s'`. Estouro vira `TransientInfrastructureError` (`55P03` no mapeador de erros) e HTTP `503` com `Retry-After: 1`.

Reconciliação usa `FOR SHARE` na wallet: bloqueia alteração de saldo durante a comparação, sem bloquear leituras.

**Alternativas descartadas:**

- *Optimistic locking com retry:* em wallet quente, o retry vira tempestade. Cada aposta que perde a corrida tenta de novo e perde de novo.
- *Lock global:* proibido pelo desafio, e serializaria wallets que não têm relação.
- *`SERIALIZABLE`:* exige retry em qualquer conflito e é mais caro que o lock de linha para este padrão.
- *Atualização condicional sem lock (`UPDATE ... WHERE balance >= x`):* funciona para débito simples, mas não cobre o ledger e a transação na mesma unidade sem lock explícito. Fica como defesa de banco (`CHECK`), não como estratégia.

Cenário obrigatório (saldo 100, duas apostas de 80 em paralelo): a segunda espera o lock, lê saldo 20 e é rejeitada com `INSUFFICIENT_FUNDS`, sem lançamento.

## 6. Schema e garantias

Cada invariante do desafio tem um mecanismo no banco, não só no código.

| Invariante | Mecanismo no banco |
|---|---|
| Uma wallet por `playerId` + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Lançamento imutável | Trigger `ledger_immutable` (`BEFORE UPDATE OR DELETE`), e o papel `wagering_app` sem `UPDATE`/`DELETE` |
| No máximo um lançamento por wallet por transação | `UNIQUE (wallet_id, transaction_id)` |
| Aritmética do lançamento | `CHECK` de `balance_after` em `CREDIT` e `DEBIT` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` |
| Um `externalTransactionId` por provedor | `UNIQUE (provider_id, external_transaction_id)` |
| Uma reversão por referência | Índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` |
| Estado terminal não muda | Trigger `wager_tx_guard` (bloqueia `UPDATE` com `OLD.status` terminal e `DELETE`) |
| Colunas de negócio imutáveis | `wager_tx_guard` aceita `UPDATE` só nas colunas da allowlist (status, referência interna, falha, snapshot, attempts, datas) |
| `REFUND`/`ROLLBACK` têm referência | `CHECK` de `reference_external_transaction_id` |
| `PROCESSED` tem data | `CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL)` |
| Inbox deduplica por consumidor | `PRIMARY KEY (consumer_name, message_id)` |
| Worker só pega pendentes vencidos | Índice parcial `(next_attempt_at) WHERE status = 'PENDING_REFERENCE'` |
| Permissões do runtime | `wagering_app` só tem `SELECT, INSERT, UPDATE` nas tabelas (sem `DELETE`) |

Papéis: `wagering_owner` é dono do schema e roda as migrations. `wagering_app` é o runtime. O init (`infra/postgres/init-roles.sql`) cria os dois.

Erros de constraint são traduzidos no caso de uso: `23505` em `(player_id, currency)` vira `DuplicateWalletError`; `23505` em `(provider_id, idempotency_key)` faz uma nova tentativa da transação (no máximo duas).

## 7. Idempotência

- `Idempotency-Key` é obrigatória no HTTP e é a fonte da verdade. Padrão recomendado: `{providerId}:{externalTransactionId}`.
- **Algoritmo do `payloadHash`:** SHA-256 em hex sobre o JSON canônico de:
  `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`.
  JSON canônico: chaves de objeto ordenadas recursivamente, sem espaços, propriedades `undefined` omitidas, arrays na ordem original. Implementação em `application/idempotency/canonical-json.ts` e `payload-hash.ts`.
- Não entram no hash: o header, `messageId`, `occurredAt`, `type` e qualquer metadado de transporte.
- Mesma key, mesmo hash, estado terminal: replay com o resultado gravado e `idempotentReplay: true`.
- Mesma key, mesmo hash, `PENDING_REFERENCE`: devolve o estado pendente com `idempotentReplay: true`, sem reprocessar.
- Mesma key, hash diferente: `IDEMPOTENCY_CONFLICT` (409), sem linha nova. A auditoria segue: log, métrica, evento `WagerTransactionRejected` e inbox na fila.
- Mesmo `externalTransactionId`, key diferente: `EXTERNAL_ID_CONFLICT` (409). Para tentar de novo, o provedor precisa mandar um `externalTransactionId` novo.
- Sem cache em memória. A garantia é o `UNIQUE` do banco.
- **Decisão: cada conflito é auditado e pode amplificar a outbox.** Cada chamada em conflito (`IDEMPOTENCY_CONFLICT` ou `EXTERNAL_ID_CONFLICT`) emite um `WagerTransactionRejected`, por auditoria. Um provedor que reenvia em loop com payload divergente gera um evento na outbox por tentativa, e a outbox publica e retenta cada um. Não há limite de emissão por provedor. Se isso virar problema, o próximo passo é limitar ou agregar esses eventos, não remover a auditoria.

## 8. Máquina de estados de `WagerTransaction`

```
PENDING            -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE  -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (attempts + 1)
PROCESSED, REJECTED, FAILED: terminais
```

- Estado terminal: qualquer transição lança `InvalidTransactionStateError` no domínio, e o trigger `wager_tx_guard` bloqueia no banco.
- `PENDING` existe no domínio, mas não é persistido no fluxo síncrono: a transação é criada e aplicada na mesma transação SQL.
- `OPENING` é interno. Não pode ser submetido pela API nem pela fila (`KIND_NOT_ALLOWED`).

## 9. Taxonomia de `failureCode`

| Código | Categoria | O que o provedor faz |
|---|---|---|
| `INVALID_PAYLOAD`, `INVALID_MONEY`, `KIND_NOT_ALLOWED` | payload | corrige o payload |
| `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` | conflito | não reenvia com a mesma key |
| `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH` | negócio | corrige os dados |
| `INSUFFICIENT_FUNDS` | negócio | desiste |
| `REVERSAL_INSUFFICIENT_FUNDS` | negócio, operacional | escala para operação |
| `REFERENCE_NOT_FOUND` | negócio, após o limite de tentativas | investiga |
| `REFERENCE_MISMATCH`, `REFERENCE_INVALID_KIND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH` | negócio | corrige ou desiste |
| `INFRA_UNAVAILABLE` | transitório | reenvia com a mesma key |
| `INFRA_PERMANENT` | permanente, vira `FAILED` | investiga |

Cada rejeição grava `failureCode` e o `failureCode` aparece na resposta HTTP e no evento.

## 10. Mapeamento HTTP

Consistente em todos os endpoints (Design §12):

| Status | Quando |
|---|---|
| `200` | transação `PROCESSED` (nova ou replay, diferenciadas por `idempotentReplay`); consultas |
| `201` | wallet criada |
| `202` | `PENDING_REFERENCE`: aceita, processamento pendente |
| `400` | `INVALID_PAYLOAD`, `INVALID_MONEY`, `KIND_NOT_ALLOWED`; UUID inválido em parâmetro (`ParseUUIDPipe`); cursor adulterado; JSON malformado (`HTTP_ERROR` mapeado para `INVALID_PAYLOAD`) |
| `404` | `NOT_FOUND`: consulta sem resultado, ledger de wallet inexistente, reconciliação de wallet inexistente |
| `409` | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` |
| `422` | rejeição de regra de negócio (com `transactionId`, `status: REJECTED`, `failureCode`, `balance`, `idempotentReplay`); o replay de rejeição também devolve `422` |
| `503` | `INFRA_UNAVAILABLE` com `Retry-After: 1`: falha transitória de infraestrutura, `lock_timeout`, conflito de versão (`ConcurrencyViolationError`), `/health/ready` com falha |
| `500` | `INTERNAL`: erro não previsto. Logado em `error` com nome e stack, nunca com o body |

Formato de erro: `{ "error": { "code": "...", "message": "..." } }`.

`PermanentInfrastructureError` cai em `500 INTERNAL`: não é algo que o provedor resolva reenviando. Erros de domínio que escapem do caso de uso também caem em `500`, mas isso indica bug: o caso de uso já converte toda regra de negócio em `422` com `failureCode`.

## 11. Referências fora de ordem

Quando a referência ainda não existe, a transação grava `PENDING_REFERENCE` com `next_attempt_at` e emite `WagerTransactionPendingReference`. Quando a referência chega e termina em qualquer estado (`PROCESSED`, `noop` de `LOSS` ou `REJECTED`), as pendentes que a referenciam ficam com `next_attempt_at = now()` (`markDependentsDue`). Assim o worker as resolve logo, em vez de esperar o backoff.

**Worker** (`ReprocessPendingReferences` e `PendingReferenceWorker`):

- Claim por lease: `UPDATE ... SET next_attempt_at = now() + 30s WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING id, wallet_id`, em transação curta com commit imediato. Se a instância morrer, a linha volta a ficar elegível em 30 s.
- Processamento, uma transação por item: `lockForUpdate(wallet)`, `lockById(transação)`, confirma `PENDING_REFERENCE` (pula se mudou), reexecuta o motor a partir do passo 7 do Design §8.
- Erro em um item não derruba o lote: é logado em `error` com `transactionId` e `errorName`, conta em `retries_total{component="pending"}` e a linha volta pelo lease.
- Backoff: `min(2^attempts, 60)` segundos.
- **Limite: 10 tentativas (`PENDING_MAX_ATTEMPTS`), cerca de 8 minutos.** Justificativa: provedores normalmente entregam a referência em segundos. Um limite curto mantém o estado auditável, e o provedor pode reenviar com um `externalTransactionId` novo. O limite é configurável.
- **Ao atingir o limite**, antes de rejeitar, o worker confere de novo se a referência chegou. Se chegou, em qualquer status, segue o caso normal. Só rejeita com `REFERENCE_NOT_FOUND` se ela continuar ausente, e então grava o evento `WagerTransactionRejected` na mesma transação.
- Shutdown: o loop para entre itens. Espera o item em andamento e devolve o restante ao lease.

## 12. SQS

**Filas:** `wager-transactions.fifo`, com redrive para `wager-transactions-dlq.fifo` e `maxReceiveCount = 5`, e `wallet-events.fifo`, destino da outbox. Todas são criadas pelo `sqs-init`, no compose e nos testes.

**Produtor:** `MessageGroupId = walletId` e `MessageDeduplicationId = messageId`. Isso é otimização, não garantia: o banco continua responsável pelas invariantes.

**Consumidor** (`WagerConsumer`):
- Long polling (`CONSUMER_WAIT_SECONDS=10`), até `CONSUMER_CONCURRENCY=5` mensagens em paralelo por instância.
- `ReceiveMessage` pede `ApproximateReceiveCount`.
- Reutiliza o **mesmo caso de uso** do HTTP (`SubmitWagerTransaction`). A inbox (`INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING`) entra na mesma transação SQL. A inbox deduplica a entrega; a `idempotencyKey` deduplica a operação. Se a mensagem não traz `data.idempotencyKey`, o padrão é `"{providerId}:{externalTransactionId}"`, o default recomendado no desafio. Um `messageId` repetido com payload diferente continua sendo tratado como duplicata (ack), mas é logado em `warn` e contado em `duplicates_detected_total{source="inbox",result="conflict"}`, porque indica bug no produtor.

**Classificação de erros:**

| Situação | Ação |
|---|---|
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, conflito, duplicata da inbox | `DeleteMessage` (ack), **só depois do commit** |
| JSON malformado, envelope inválido, `InvalidPayloadError`, `InvalidMoneyError` | permanente: copia para a DLQ com o atributo `reason` (`MALFORMED_JSON`, `INVALID_PAYLOAD`, `INVALID_MONEY`) e só então apaga da fila principal. Se a cópia falhar, vira retry: nunca apaga sem copiar |
| `TransientInfrastructureError`, `ConcurrencyViolationError`, `lock_timeout` | transitório: sem ack, `ChangeMessageVisibility(min(2^receiveCount, 60))`, métrica `retries_total{component="consumer"}`. Depois de 5 recebimentos, o redrive do SQS move a mensagem para a DLQ |
| Qualquer outro erro | permanente com `reason = INFRA_PERMANENT`. Neste caso a transação **não** é gravada como `FAILED`; a mensagem na DLQ é o registro auditável |

**Shutdown:** o consumidor para de iniciar novos `receive`, mas não aborta o long poll em curso. Abortar deixaria as mensagens que o servidor já entregou invisíveis por até 30 s. As mensagens trazidas por esse último `receive` voltam com visibilidade 0. Depois ele espera as mensagens em andamento por até `SHUTDOWN_GRACE_MS=20000` e devolve as restantes com `ChangeMessageVisibility(0)`.

**Relação com o Docker (`stop_grace_period: 40s`).** O pior caso de shutdown é `CONSUMER_WAIT_SECONDS` (10 s, o long poll em curso) somado a `SHUTDOWN_GRACE_MS` (20 s, o prazo para as mensagens em andamento): 30 s. O `stop_grace_period` do serviço `app` é 40 s, porque o Docker só manda `SIGKILL` depois desse prazo. Os 10 s extras cobrem o fechamento do ORM e a saída do processo. Com o padrão do Docker (10 s), o `SIGKILL` cairia antes do fim do shutdown normal. Se mesmo assim o processo for morto, a mensagem em andamento volta pelo visibility timeout, e a inbox impede a dupla aplicação se o commit já tiver ocorrido.

**Crash depois do commit e antes do ack:** a mensagem volta pelo visibility timeout, a inbox detecta a duplicata e nada é aplicado de novo. Teste C5 (`FAULT_INJECT=exit_after_commit`, ativo só com `NODE_ENV=test`).

## 13. Outbox

- **Atomicidade:** transação, saldo, lançamento, inbox e evento são gravados na mesma transação SQL. O evento só vai para a fila depois do commit, pelo publicador.
- **Claim:** `UPDATE ... SET locked_until = now + lease WHERE id IN (SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now AND (locked_until IS NULL OR locked_until < now) FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING *`, em transação curta. Vários publicadores não pegam a mesma linha nem se bloqueiam.
- **Publicação:** `MessageDeduplicationId = eventId` e `MessageGroupId = aggregateId`. Depois do envio, `published_at` é gravado em outra transação curta.
- **Falha de envio:** `scheduleRetry` (backoff `min(2^attempts, 300)` s), libera o lease, incrementa `retries_total{component="outbox"}` e segue para a próxima mensagem do lote.
- **Crash entre publicar e marcar:** o lease (30 s) expira e outra instância republica. Isso é at-least-once: o consumidor do evento deduplica por `eventId`, e o FIFO também deduplica dentro da janela de 5 minutos. Testes: publicadores concorrentes no mesmo processo e em 2 processos (C6, com 300 eventos, cada um publicado exatamente uma vez), e crash com lease de 1 s.
- **Ordem por wallet: best-effort.** `MessageGroupId = aggregateId` dá ordem FIFO dentro do grupo no SQS, mas a ordem de publicação não é garantida. Falha de envio agenda retry e o lote segue, então a mensagem falha pode sair depois das seguintes; publishers concorrentes também podem reordenar. Consumidores de `WalletBalanceChanged` devem ordenar por `data.walletVersion`, não pela ordem de chegada.
- **Lag:** `outbox_lag_seconds` é a idade do evento pendente mais antigo, atualizada a cada tick.
- Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference`, e `WalletCreated` (extra).
- Envelope: classe abstrata `IntegrationEvent<T>` com `eventType` e `version` no tipo. `data` carrega `MoneyProps` (string), nunca `Money`.

## 14. Autenticação

**Decisão: não implementar autenticação real.** O desafio aceita a decisão, desde que documentada (README §2).

- Endpoints de negócio têm `AuthGuard` no-op, aplicado no ponto de extensão.
- `ProviderIdentityPort.assertCanActAs(providerId)` é o ponto de extensão para validar a identidade do provedor (no-op por enquanto).
- Health e métricas não exigem autenticação.
- Mensagens SQS são tratadas como canal interno confiável; a identidade do provedor no corpo continua sujeita às validações de domínio.

**Desenho adotado se houvesse IdP:** Keycloak em Docker Compose (OIDC client credentials por provedor). O token traz o claim `provider_id`, que precisa ser igual ao `providerId` do body. Esse seria o único lugar que faria a checagem de `ProviderIdentityPort`. Zitadel serviria igualmente.

## 15. Interpretações adotadas

Pontos em que o README deixou margem. Cada um tem teste.

1. **Regra 4 (dupla reversão):** uma referência só pode ser revertida uma vez no total, por `REFUND` ou por `ROLLBACK`. Motivo: `REFUND` seguido de `ROLLBACK` da mesma BET creditaria duas vezes. `ROLLBACK` de um `REFUND` é permitido, porque a referência é outra transação. Garantido pelo índice único parcial.
2. **`WALLET_NOT_FOUND`:** rejeição sem linha em `wager_transactions`, porque a FK exige wallet. A rejeição fica auditável por log, métrica e evento `WagerTransactionRejected` com `transactionId` ausente.
3. **`EXTERNAL_ID_CONFLICT`:** `externalTransactionId` é a identidade de negócio da operação no provedor. Assim `UNIQUE (provider_id, external_transaction_id)` vale e a resolução de referência acha no máximo uma linha.
4. **`WIN` com referência:** pode referenciar uma BET da mesma rodada. A referência só é verificada se existir; `WIN` sem referência credita direto.
5. **`BET` com referência:** a referência é ignorada pelo motor. A aposta não depende de outra transação.
6. **`LOSS`:** aplica as checagens de referência de `WIN` quando há referência, sem checagem de valor, e não move saldo.
7. **Referência encontrada em `PENDING` (nunca persistido):** trata como pendente.
8. **Reversão com saldo insuficiente:** `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`, porque a operação é diferente (escala para operação).
9. **Ledger de wallet inexistente:** `404`. O README não definiu.
10. **`limit` acima de 200:** reduzido para 200. `limit` inválido: `400`.
11. **Cursor:** `base64url("v1:{seq}")`, validado por re-encode. Variantes de base64 equivalentes também dão `400`.

## 16. Observabilidade

- **Logs:** pino em JSON. Contexto via `AsyncLocalStorage` (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`). Redaction de `*.money`, `*.amount`, `*.balance`, `req.body` e `req.headers.authorization`. Erros de 500 são logados com nome e stack, nunca com o body. Depois de cada commit sai uma linha `info` por resultado, com `transactionId`, `status`, `failureCode`, `kind`, `source` e `idempotentReplay`, sem valores monetários. O worker de pendentes loga cada resolução, e o publicador da outbox loga uma linha por lote não vazio (`claimed`, `published`, `failed`).
- **Métricas** (prom-client, `GET /metrics`): `wager_transactions_total{status,kind}`, `duplicates_detected_total{source,result}`, `retries_total{component}`, `dlq_messages_total`, `lock_conflicts_total` (incrementada em `55P03` lock timeout, `40P01` deadlock, `40001` serialization failure e conflito de versão), `outbox_lag_seconds`, `processing_duration_seconds`, `wallet_lock_wait_seconds` (histograma tirado em cada `FOR UPDATE` da wallet, inclusive quando termina em erro), `reconciliation_mismatches_total`.
  - `duplicates_detected_total` tem o label `result` além de `source`. O Design §16 lista só `source`.
- **Health:** `GET /health/live` responde só se o processo vive. `GET /health/ready` faz `SELECT 1` e `QueuePort.ping()` (`GetQueueAttributes` na fila principal); se qualquer um falhar, responde `503 INFRA_UNAVAILABLE`.

## 17. Troca de LocalStack por MiniStack

O Design e o README aceitam LocalStack ou MiniStack. A escolha foi **MiniStack `ministackorg/ministack:1.5.35`**.

Motivo: o LocalStack exige `LOCALSTACK_AUTH_TOKEN` para subir (verificado: sai com código 55 sem token). O avaliador precisa rodar a solução sem conta. O MiniStack sobe sem token, e foram verificados: filas FIFO, `RedrivePolicy` com `maxReceiveCount`, `ChangeMessageVisibility` e `ApproximateReceiveCount`.

O MiniStack não tem hooks de inicialização equivalentes aos do LocalStack. Por isso as filas são criadas por um serviço one-shot `sqs-init` (`amazon/aws-cli:2.17.0`, tag fixa), com `depends_on` e healthcheck do MiniStack.

Limitação conhecida: o MiniStack é uma emulação. Comportamentos finos de SQS FIFO (deduplicação de janela de 5 min, visibilidade por fila) foram conferidos só nos pontos acima, não contra AWS.

## 18. Limitações conhecidas

- Sem reversão parcial: `REFUND` e `ROLLBACK` têm que bater o valor da referência.
- Reconciliação detecta, não corrige. Divergência vira log, métrica e resposta com `consistent: false`.
- Cenários de teste usam só `BRL`. Multi-moeda está no modelo; conflito é testado com `USD`.
- Sem ledger de partidas dobradas (opcional no desafio).
- Throughput de publicação da outbox: cerca de 100 eventos/s nas 3 réplicas contra o MiniStack, porque o envio é feito um a um, sem `SendMessageBatch`. Sob carga sustentada o backlog cresce. A correção não é afetada, só a latência de entrega dos eventos. Detalhes e melhorias em [docs/load-test.md](docs/load-test.md).
- Autenticação é um ponto de extensão, não uma implementação.
- Cadeias de pendentes: se a referência existe mas também está `PENDING_REFERENCE`, o dependente continua pendente. A cadeia sempre termina, porque a raiz esgota o limite e é rejeitada com `REFERENCE_NOT_FOUND`, e o `markDependentsDue` no `reject` acorda os dependentes. Eles então terminam com `REFERENCE_NOT_PROCESSED`. O tempo máximo de uma cadeia é o tempo da raiz mais um ciclo do worker por nível.
- O teste de `SIGTERM` com processo real roda em Linux e macOS. No Windows ele é pulado (`skipIf(win32)`), porque o Windows não entrega `SIGTERM` (o `kill` vira `TerminateProcess`). Lá o mesmo caminho é coberto dentro do processo, via `app.close()`. A suíte completa foi verificada nos dois sistemas.
- O processo sai com código 0 depois de um shutdown limpo (`enableShutdownHooks(..., { useProcessExit: true })`). Sem essa opção, o Nest reenvia o sinal ao próprio processo depois dos hooks, e o código de saída fica 143, como se o shutdown tivesse sido abortado.
- Erro permanente inesperado no consumidor vai para a DLQ, mas não grava a transação como `FAILED`.
- MiniStack é emulação: diferenças com AWS podem existir.
- Testes de integração e concorrência isolam o banco por execução com `TEST_DB_NAME` (um banco por execução ou pipeline) e as portas dos processos com `TEST_PORT_BASE`. Em CI ou dentro de um container, `TEST_DB_HOST`, `TEST_SQS_ENDPOINT` e `TEST_DOCKER_HOST` apontam os testes para a infraestrutura certa. Duas execuções no mesmo banco se atrapalham, porque cada teste faz `TRUNCATE`.
