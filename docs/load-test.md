# Teste de carga

Script: `scripts/load-test.ts` (`bun run test:load`). Resultados brutos em `docs/load-test/`:

| Rodada | Arquivo | O que mudou |
|---|---|---|
| 1. Baseline | [`results-2026-11-01T03-07-00.486Z.json`](load-test/results-2026-11-01T03-07-00.486Z.json) | publisher com um `SendMessage` por evento |
| 2. Envio em lote | [`results-2026-11-01T06-06-08.495Z.json`](load-test/results-2026-11-01T06-06-08.495Z.json) | `SendMessageBatch` (10 por chamada) |
| 3. Events sink | [`results-2026-11-01T06-31-47.479Z.json`](load-test/results-2026-11-01T06-31-47.479Z.json) | consumidor de `wallet-events.fifo` no teste; publisher agenda o próximo ciclo na hora após lote cheio |
| 4. Perfil SQS | [`results-2026-11-01T06-43-39.771Z.json`](load-test/results-2026-11-01T06-43-39.771Z.json) | entrada pela fila `wager-transactions.fifo` |

O objetivo não é bater uma meta de RPS. O teste responde três perguntas: o sistema continua correto sob carga? Onde está o gargalo? Como a contenção por wallet aparece na latência?

## Ambiente

| Item | Valor |
|---|---|
| CPU | AMD Ryzen 5 5600X (6 núcleos, 12 threads) |
| Memória | 15,9 GiB |
| SO | Windows 10 (19045), Docker Desktop 29.9.2 |
| Runtime | Bun 1.4.4 |
| Topologia | 3 réplicas do app (`APP_ROLES=api,consumer,outbox,pending`), 1 PostgreSQL 17.6, 1 MiniStack 1.5.35, tudo via `docker compose up --scale app=3` |
| Gerador | na **mesma máquina** dos containers, disputando CPU com eles |

## Metodologia

- **Gerador próprio em Bun, em loop fechado.** São 50 usuários virtuais; cada um envia um `POST /wagering/transactions`, espera a resposta e envia o próximo. Os alvos são as 3 réplicas, em round-robin.
- **Janela.** 5 s de aquecimento seguidos de 30 s medidos. Latência e throughput vêm só da janela medida; os percentis são exatos, calculados sobre o array ordenado. Os deltas das métricas do servidor cobrem o perfil inteiro, aquecimento incluído.
- **Perfis HTTP:**
  - `spread`: 200 wallets, `BET 1.00` numa wallet aleatória. Mede o caminho feliz sem contenção.
  - `hot`: 1 wallet, os 50 usuários apostando nela. Estressa o lock por wallet (`SELECT ... FOR UPDATE`).
  - `mixed`: 200 wallets. Cada `BET` pode ser seguida de `WIN` (50%), `LOSS` (30%) ou `REFUND` (20%) referenciando a aposta. Além disso, 10% das requisições repetem uma anterior com a mesma `Idempotency-Key`.
- **Perfil `sqs`** (`LOAD_PROFILES=sqs`): não usa HTTP. Enfileira 20.000 `BET` em `wager-transactions.fifo` (200 wallets), com um reenvio a cada 20 mensagens (1.000 duplicatas), em lotes de 10 (`SendMessageBatch`), 4 envios concorrentes. Envia em 10 ondas de 2.000; antes de cada onda (exceto a primeira) espera a profundidade da fila (visíveis + em voo) cair até 2.000. A taxa de processamento é `únicas / (primeiro envio até a fila zerar)`, já com essa contrapressão incluída.
- **Events sink.** A partir da rodada 3, o teste sobe 4 workers que consomem `wallet-events.fifo` e contam as mensagens recebidas (`sink.received`, `sink.ratePerSecond`). Antes, essa fila não tinha consumidor e acumulava eventos.
- **Classificação.** `200`/`202` contam como sucesso. `409`/`422` são rejeição de negócio esperada. `5xx`, timeout e erro de rede são erro.
- **Servidor.** `/metrics` das 3 réplicas é lido antes e depois de cada perfil (`lock_conflicts_total`, `wager_transactions_total`, `retries_total`, duplicatas). `outbox_lag_seconds` é amostrado a cada 1 s.
- **Correção.** No fim de cada perfil, `POST /wallets/:id/reconciliation` roda em **todas** as wallets do perfil. Se qualquer uma der `consistent: false`, o script sai com código 1.
- **Isolamento entre perfis.** Antes de cada perfil, o script espera a outbox zerar, para o backlog de um perfil não contaminar o seguinte.

## Rodadas

Perfis HTTP, 50 usuários, janela de 30 s. Lag ao fim = `outbox_lag_seconds` depois de +60 s de drenagem. Sink/s = mensagens recebidas em `wallet-events.fifo` por segundo (só a partir da rodada 3).

| Perfil | Rodada | req/s | p95 | Lag ao fim | Sink/s |
|---|---|---:|---:|---:|---:|
| `spread` | 1. Baseline | 1214,7 | 68,5 ms | 88,5 s | n/d |
| `spread` | 2. Lote | 1047,6 | 90,9 ms | 83,3 s | n/d |
| `spread` | 3. Sink | 1028,3 | 87,4 ms | 80,1 s | 275,2 |
| `hot` | 1. Baseline | 279,1 | 526,1 ms | 79,5 s | n/d |
| `hot` | 2. Lote | 251,9 | 375,2 ms | 78,8 s | n/d |
| `hot` | 3. Sink | 263,8 | 529,9 ms | 78,7 s | 59,6 |
| `mixed` | 1. Baseline | 1072,6 | 88,1 ms | 91,7 s | n/d |
| `mixed` | 2. Lote | 1078,2 | 93,8 ms | 90,6 s | n/d |
| `mixed` | 3. Sink | 1056,8 | 99,6 ms | 89,9 s | 38,1 |

- **Erros:** 0 em todos os perfis e rodadas (0 `5xx`, 0 timeout, 0 erro de rede). `lock_conflicts_total` ficou em 0 e `retries_total` não aumentou.
- **Correção:** todas as reconciliações deram 0 divergências (401 wallets por rodada: 200 + 1 + 200).
- **Idempotência (`mixed`):** todos os replays enviados voltaram com `idempotentReplay: true` (2.997, 2.883 e 2.846 nas três rodadas).
- **HTTP estável entre as rodadas.** O `spread` ficou entre 1.028 e 1.215 req/s, com p95 de 68 a 91 ms. O baseline foi a rodada mais rápida e as duas seguintes ficaram ~14% abaixo dele; o `mixed` ficou entre 1.057 e 1.078 req/s. Cada rodada é uma execução única de 30 s, sem repetição, então não dá para separar uma mudança real da variação de uma rodada só, num gerador que divide a CPU com o sistema. O p95 do `hot` (375 a 530 ms) varia por causa da distribuição bimodal descrita na Análise. Nenhuma das mudanças na outbox tinha motivo para alterar o caminho HTTP, e os dados não indicam que alteraram.

### Outbox

Lag máximo na janela e lag ao fim de +60 s de drenagem. O tempo até zerar é estimado: duração do perfil mais 60 s de drenagem mais o tempo de espera do perfil seguinte (`preSettle`). O `mixed` é o último perfil, então não foi medido.

| Perfil | Rodada | lag máx. na janela | lag ao fim de +60 s | tempo até zerar |
|---|---|---:|---:|---:|
| `spread` | 1. Baseline | 32,7 s | 88,5 s | ~809 s (35 + 60 + 713) |
| `spread` | 2. Lote | 29,5 s | 83,3 s | ~562 s (35 + 60 + 467) |
| `spread` | 3. Sink | 26,8 s | 80,1 s | ~528 s (35 + 60 + 433) |
| `hot` | 1. Baseline | 32,0 s | 79,5 s | ~208 s (35 + 60 + 113) |
| `hot` | 2. Lote | 30,0 s | 78,8 s | ~182 s (36 + 60 + 86) |
| `hot` | 3. Sink | 28,4 s | 78,7 s | ~223 s (36 + 60 + 127) |
| `mixed` | 1. Baseline | 33,2 s | 91,7 s | não medido |
| `mixed` | 2. Lote | 30,4 s | 90,6 s | não medido |
| `mixed` | 3. Sink | 27,6 s | 89,9 s | não medido |

Em todas as rodadas o lag cresce durante a janela e continua crescendo na drenagem: o publisher nunca alcança o primeiro evento antes do fim. O lag é a idade do evento pendente mais antigo, e os eventos só começam a nascer no início do perfil, por isso o máximo na janela fica perto da duração do perfil.

**O envio em lote e o agendamento imediato após lote cheio não mudaram a vazão no ambiente: ~100 eventos/s.** As variações da tabela (por exemplo, o `spread` zerando em ~809 s, depois ~562 s e ~528 s) não bastam para dizer o contrário: o `preSettle` depende também do tamanho do backlog que cada rodada produziu (as rodadas 2 e 3 geraram menos transações no `spread`: 35.944 e 34.472 `BET`, contra 41.582) e a ordem de grandeza continua a mesma.

### Perfil SQS

Fonte: `results-2026-11-01T06-43-39.771Z.json`.

| Item | Valor |
|---|---|
| Mensagens únicas / reenvios / enviadas | 20.000 / 1.000 / 21.000 |
| Ondas | 10 de 2.000 (contrapressão em 2.000 de profundidade) |
| Envio (`enqueueSeconds`) | 80,9 s |
| Espera por contrapressão | 182,2 s |
| Drenagem final | 86,0 s |
| Total fim a fim | 349,1 s |
| Processadas/s | 57,3 |
| Profundidade máxima de `wager-transactions.fifo` | 3.820 |
| Duplicatas detectadas (`duplicates_detected_total`, origem `message`) | 1.000 (todas as reenviadas) |
| DLQ | 0 |
| Transações `PROCESSED` | 20.000 |
| Outbox ao fim | drenou em 1,0 s, lag 0 |
| Events sink | 40.600 mensagens recebidas, 115,7/s |
| Reconciliação | 200 wallets, 0 divergências |

Os 40.600 eventos do sink são exatamente 20.000 `BET` × 2 eventos (`WagerTransactionProcessed` e `WalletBalanceChanged`) + 200 wallets × 3 eventos (os da preparação das wallets do perfil). Ou seja: nenhum evento perdido e nenhum duplicado apesar de 1.000 reenvios.

## Análise

**1. O gargalo da publicação é o MiniStack, não o código da outbox.**
- **Produção:** no `spread`, cada `BET` gera 2 eventos, cerca de 2.400 eventos/s durante a janela.
- **Publicação medida:** as 3 réplicas juntas publicam cerca de **100 eventos/s**, antes e depois do envio em lote.
- **Envio em lote e publisher sem espera após lote cheio** são corretos, mas **não mudaram a vazão no ambiente** (~100 eventos/s). A hipótese inicial, "o custo é por mensagem no emulador", foi refutada por medição.
- **Causa raiz medida:** no MiniStack, o custo de envio **cresce com a profundidade da fila**. `sendBatch` em série:

  | Profundidade da fila | Vazão |
  |---|---:|
  | ~0 mensagens | 3.116 msg/s |
  | ~20,5 mil | 261 msg/s |
  | ~51 mil | 109 msg/s |

  Em fila vazia: `send` em série = 746 msg/s, `sendBatch` em série = 4.035 msg/s, `sendBatch` em paralelo = 5.356 msg/s. Ou seja, o lote funciona (5,4x sobre o `send` em série) quando a fila está vazia. Sem consumidor, `wallet-events.fifo` acumula ~90 mil mensagens, e o ambiente cai para o regime de ~100 msg/s.
- **O SQL não é o gargalo:** o claim com 60 mil pendentes leva ~80 ms e o `MIN(occurred_at)` ~35 ms.
- **O consumidor também não resolve:** mesmo com o events sink drenando `wallet-events.fifo`, ele só recebeu de 38 a 275 msg/s (38,1 no `mixed`, 59,6 no `hot`, 275,2 no `spread`). O MiniStack é um processo Python que ficou perto de 85% de CPU, ou seja, um núcleo saturado: ele é o teto do ambiente tanto para publicar quanto para consumir.
- **Capacidade do publisher sem SQS** (`bun run bench:outbox`: `QueuePort` no-op, 50 mil eventos, só claim e `markPublishedMany` no PostgreSQL):

  | Publicadores | Vazão |
  |---|---:|
  | 1 | 2.110 ev/s |
  | 3 | 6.486 ev/s |

  Com 3 publicadores, a capacidade fica acima dos ~2.400 ev/s que o teste produz. **Conclusão: o código não é o gargalo.** Em produção, com SQS real, não se espera o comportamento do emulador, mas isso não foi medido aqui.
- **A correção não foi afetada.** O evento está gravado na mesma transação do saldo e só é publicado depois do commit. O que cresce é a latência de entrega do evento, não o risco de perdê-lo; o `sqs` mostra a outbox zerando em ~1 s quando a fila de eventos não está acumulada.
- **Proteção operacional:** alerta em `outbox_lag_seconds`.

**2. `sqs`: processamento correto, vazão limitada pelo ambiente.**
- 57,3 transações/s com a contrapressão incluída (os 182 s de espera pela fila baixar a 2.000 estão no denominador). Os 1.000 reenvios foram todos detectados como duplicata de mensagem, sem DLQ e sem divergência de saldo. Esse número é do ambiente (MiniStack saturado), não uma capacidade do consumidor medida isoladamente.

**3. `hot`: serialização por wallet, como no desenho.**
- **Throughput limitado pelo lock.** Com 50 usuários numa única wallet, o throughput fica entre 252 e 279 req/s, e a latência média bate com a lei de Little: no baseline, 50 / 279,1 ≈ 0,179 s (média medida: 178,8 ms).
- **O sistema funciona como uma fila na linha da wallet**, com ~3,6 ms de serviço por transação dentro do lock. Esse é o custo esperado do `SELECT ... FOR UPDATE`. Em troca, não há retry nem lost update, e wallets diferentes continuam em paralelo: o `spread` faz de 3,9x a 4,3x mais.
- **A distribuição é bimodal** (baseline: p50 de 14,5 ms e p95 de 526 ms; na rodada 2, p50 de 231,5 ms e p95 de 375 ms). Uma hipótese, **não verificada**, é que a fila de lock do PostgreSQL não atende em ordem de chegada entre conexões de réplicas diferentes.

**4. `lock_conflicts_total = 0` não significa que não houve espera.**
- **O que a métrica conta:** só lock timeout (`55P03`, com `lock_timeout = 5s`), deadlock (`40P01`), serialization failure (`40001`) e conflito de versão. No `hot`, nenhuma espera chegou a 5 s, então não houve conflito.
- **O que ela não mede:** a espera por lock em si. Para isso existe a métrica `wallet_lock_wait_seconds`, adicionada depois do primeiro run. Ela já está instrumentada, mas **os números das rodadas acima não a reportam**: o gerador não a lê ainda.

**5. `mixed`: o custo das referências é pequeno.** No baseline, o p50 sobe de 40,7 para 45,4 ms em relação ao `spread`. Isso vem das leituras extras: a resolução da referência e `isReversed`.

## Limitações do experimento

- **O MiniStack é o teto do ambiente.** É um emulador em Python, com um núcleo saturado (~85% de CPU). Ele limita a publicação e o consumo, e seu custo de envio cresce com a profundidade da fila. Os números de vazão de eventos e do perfil `sqs` descrevem esse ambiente, não o SQS da AWS.
- **Gerador e sistema dividem a mesma CPU**, então os números absolutos estão subestimados.
- **Docker Desktop no Windows** adiciona uma camada de virtualização de rede e disco.
- **Uma execução por perfil e rodada, com janela de 30 s.** Não há repetição, intervalo de confiança nem teste de estabilidade longa. Diferenças de ~15% em req/s entre rodadas não são distinguíveis de variação.
- **A capacidade da outbox sem SQS vem de um benchmark à parte** (`bench:outbox`), com `QueuePort` no-op e PostgreSQL de teste, fora da topologia de 3 réplicas com carga HTTP simultânea.
- **`wallet_lock_wait_seconds` já existe, mas as rodadas não a reportam.** A espera por lock do `hot` segue inferida pela latência (lei de Little), não medida diretamente.
- **O perfil `sqs` mede um caminho de entrada só** (`BET`, 200 wallets), com contrapressão que faz parte do denominador.
- **Sem latência de rede entre cliente e servidor.**

## Como reproduzir

```bash
docker compose down -v
docker compose up -d --build --scale app=3
# espere /health/ready responder 200 em 3001, 3002 e 3003
bun run test:load
# parâmetros: LOAD_CONCURRENCY=50 LOAD_DURATION_S=30 LOAD_WARMUP_S=5 LOAD_PROFILES=spread,hot,mixed LOAD_TARGETS=http://localhost:3001,...

# perfil SQS (entrada pela fila wager-transactions.fifo)
LOAD_PROFILES=sqs bun run test:load

# capacidade do publisher da outbox sem SQS (requer `bun run infra:test:up`)
TEST_DB_NAME=wagering_bench bun run bench:outbox

docker compose down -v
```

O run HTTP completo leva cerca de 14 a 19 minutos, principalmente pela espera da outbox zerar entre os perfis. O perfil `sqs` leva cerca de 6 minutos.
