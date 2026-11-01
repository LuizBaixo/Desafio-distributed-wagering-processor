#!/bin/sh
# Cria as filas FIFO no MiniStack. Idempotente: recriar com os mesmos atributos não falha.
set -eu

ENDPOINT="${SQS_ENDPOINT:-http://ministack:4566}"
AWS="aws --endpoint-url ${ENDPOINT}"
ACCOUNT="000000000000"
WORK="/tmp/sqs-init"
mkdir -p "${WORK}"

# 1. DLQ primeiro, porque a RedrivePolicy da fila principal exige o ARN dela.
printf '%s' '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' > "${WORK}/dlq.json"
${AWS} sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes "file://${WORK}/dlq.json" >/dev/null
DLQ_URL="${ENDPOINT}/${ACCOUNT}/wager-transactions-dlq.fifo"
DLQ_ARN=$(${AWS} sqs get-queue-attributes --queue-url "${DLQ_URL}" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# 2. Fila principal com redrive para a DLQ após 5 recebimentos.
printf '%s' "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":5}\"}" > "${WORK}/wager.json"
${AWS} sqs create-queue --queue-name wager-transactions.fifo --attributes "file://${WORK}/wager.json" >/dev/null

# 3. Fila de eventos (destino da outbox).
printf '%s' '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' > "${WORK}/events.json"
${AWS} sqs create-queue --queue-name wallet-events.fifo --attributes "file://${WORK}/events.json" >/dev/null

echo "SQS init ok: wager-transactions.fifo, wager-transactions-dlq.fifo, wallet-events.fifo"
