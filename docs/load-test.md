# Teste de carga

Resultado bruto: [`load-test/results-2026-11-01T03-07-00.486Z.json`](load-test/results-2026-11-01T03-07-00.486Z.json). Script: `scripts/load-test.ts` (`bun run test:load`).

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
- **Perfis:**
  - `spread`: 200 wallets, `BET 1.00` numa wallet aleatória. Mede o caminho feliz sem contenção.
  - `hot`: 1 wallet, os 50 usuários apostando nela. Estressa o lock por wallet (`SELECT ... FOR UPDATE`).
  - `mixed`: 200 wallets. Cada `BET` pode ser seguida de `WIN` (50%), `LOSS` (30%) ou `REFUND` (20%) referenciando a aposta. Além disso, 10% das requisições repetem uma anterior com a mesma `Idempotency-Key`.
- **Classificação.** `200`/`202` contam como sucesso. `409`/`422` são rejeição de negócio esperada. `5xx`, timeout e erro de rede são erro.
- **Servidor.** `/metrics` das 3 réplicas é lido antes e depois de cada perfil (`lock_conflicts_total`, `wager_transactions_total`, `retries_total`). `outbox_lag_seconds` é amostrado a cada 1 s.
- **Correção.** No fim de cada perfil, `POST /wallets/:id/reconciliation` roda em **todas** as wallets do perfil. Se qualquer uma der `consistent: false`, o script sai com código 1.
- **Isolamento entre perfis.** Antes de cada perfil, o script espera a outbox zerar, para o backlog de um perfil não contaminar o seguinte.

## Resultados

| Perfil | req/s | p50 | p95 | p99 | máx | média | erros | `lock_conflicts_total` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `spread` | 1214,7 | 40,7 ms | 68,5 ms | 83,7 ms | 147,1 ms | 41,2 ms | 0 | 0 |
| `hot` | 279,1 | 14,5 ms | 526,1 ms | 560,9 ms | 633,2 ms | 178,8 ms | 0 | 0 |
| `mixed` | 1072,6 | 45,4 ms | 88,1 ms | 112,2 ms | 168,2 ms | 46,6 ms | 0 | 0 |

- **Taxa de erro:** 0% nos três perfis (0 `5xx`, 0 timeout, 0 erro de rede). `retries_total` não aumentou.
- **Idempotência sob carga (`mixed`):** os 2.997 replays enviados voltaram todos com `idempotentReplay: true`.
- **Correção:** 401 wallets reconciliadas (200 + 1 + 200), **0 divergências**. Saída 0.
- **Transações aplicadas** (deltas do servidor):
  - `spread`: 41.582 `BET`.
  - `hot`: 9.772 `BET`.
  - `mixed`: 17.099 `BET`, 8.606 `WIN`, 5.080 `LOSS` e 3.391 `REFUND`.

### Outbox

| Perfil | lag máx. na janela | lag ao fim de +60 s | tempo até zerar |
|---|---:|---:|---:|
| `spread` | 32,7 s | 88,5 s | cerca de 809 s (35 + 60 + 713) |
| `hot` | 32,0 s | 79,5 s | cerca de 208 s (35 + 60 + 113) |
| `mixed` | 33,2 s | 91,7 s | não medido (fim do run) |

Na janela medida, o lag máximo fica perto de 33 s porque o lag é a idade do evento pendente mais antigo, e os eventos só começam a nascer no início do perfil. O backlog cresceu o tempo todo: o publicador nunca alcançou o primeiro evento.

## Análise

**1. O gargalo é a publicação da outbox, não o processamento.**
- **Produção:** no `spread`, cada `BET` gera 2 eventos (`WagerTransactionProcessed` e `WalletBalanceChanged`), cerca de 2.400 eventos/s durante a janela.
- **Publicação:** as 3 réplicas juntas publicaram cerca de **100 eventos/s**:
  - `spread`: ~83,8 mil eventos em ~809 s;
  - `hot`: ~19,5 mil eventos em ~208 s.
- **Causas prováveis**, em ordem de impacto estimado (não medidas uma a uma):
  - um `SendMessage` por evento, sem lote;
  - um `markPublished` por evento, em transação própria;
  - o MiniStack é um emulador. Durante o teste, ele chegou a ~80% de CPU, enquanto as réplicas do app ficaram perto de 5%.

  Esses números não preveem o comportamento no SQS da AWS.
- **A correção não foi afetada.** O evento está gravado na mesma transação do saldo e é publicado depois. O que cresce é a latência de entrega do evento, não o risco de perdê-lo.
- **Melhorias, por custo:**
  - `SendMessageBatch` (10 por chamada) mais `markPublished` em lote (`UPDATE ... WHERE id = ANY(?)`): ganho esperado da ordem de 10x;
  - mais publicadores por réplica, porque o claim com `SKIP LOCKED` já permite;
  - lease proporcional ao tamanho do lote;
  - alerta em `outbox_lag_seconds`.

**2. `hot`: serialização por wallet, como no desenho.**
- **Throughput limitado pelo lock.** Com 50 usuários numa única wallet, o throughput cai para 279 req/s, e a latência média (178,8 ms) bate com a lei de Little: 50 / 279,1 ≈ 0,179 s.
- **O sistema funciona como uma fila na linha da wallet**, com ~3,6 ms de serviço por transação dentro do lock. Esse é o custo esperado do `SELECT ... FOR UPDATE`. Em troca, não há retry nem lost update, e wallets diferentes continuam em paralelo: o `spread` faz 4,3x mais.
- **A distribuição é bimodal** (p50 de 14,5 ms, p95 de 526 ms). Uma hipótese, **não verificada**, é que a fila de lock do PostgreSQL não atende em ordem de chegada entre conexões de réplicas diferentes.

**3. `lock_conflicts_total = 0` não significa que não houve espera.**
- **O que a métrica conta:** só lock timeout (`55P03`, com `lock_timeout = 5s`), deadlock (`40P01`), serialization failure (`40001`) e conflito de versão. No `hot`, nenhuma espera chegou a 5 s, então não houve conflito.
- **O que ela não mede:** a espera por lock em si. Para isso falta uma métrica, por exemplo um histograma do tempo entre o início da transação e a obtenção do `FOR UPDATE`.

**4. `mixed`: o custo das referências é pequeno.** O p50 sobe de 40,7 para 45,4 ms em relação ao `spread`. Isso vem das leituras extras: a resolução da referência e `isReversed`.

## Limitações do experimento

- **Gerador e sistema dividem a mesma CPU**, então os números absolutos estão subestimados.
- **Docker Desktop no Windows** adiciona uma camada de virtualização de rede e disco.
- **MiniStack é emulação:** o throughput de publicação não representa o SQS real.
- **Uma rodada só por perfil, com janela de 30 s.** Não há intervalo de confiança nem teste de estabilidade longa.
- **Só a entrada HTTP foi carregada.** A entrada SQS (consumidor) não foi medida.
- **Sem latência de rede entre cliente e servidor.**

## Como reproduzir

```bash
docker compose down -v
docker compose up -d --build --scale app=3
# espere /health/ready responder 200 em 3001, 3002 e 3003
bun run test:load
# parâmetros: LOAD_CONCURRENCY=50 LOAD_DURATION_S=30 LOAD_WARMUP_S=5 LOAD_PROFILES=spread,hot,mixed LOAD_TARGETS=http://localhost:3001,...
docker compose down -v
```

O run completo leva cerca de 15 minutos, principalmente pela espera da outbox zerar entre os perfis.
