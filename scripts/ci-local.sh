#!/usr/bin/env bash
# Reproduz localmente os passos do job `test` de .github/workflows/ci.yml,
# dentro de um container oven/bun:1.4.4-alpine.
#
# Pré-requisito: a infra de teste já está de pé no host (bun run infra:test:up).
set -eu

# Git Bash no Windows converteria os caminhos de -v; no Linux a variável não tem efeito.
export MSYS_NO_PATHCONV=1

BUN_IMAGE="oven/bun:1.4.4-alpine"

ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"

TEST_DB_NAME="${TEST_DB_NAME:-wagering_ci}"
TEST_PORT_BASE="${TEST_PORT_BASE:-4101}"

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$ROOT:/app" \
  -w /app \
  -e TEST_DB_NAME="$TEST_DB_NAME" \
  -e TEST_PORT_BASE="$TEST_PORT_BASE" \
  -e TEST_DB_HOST=host.docker.internal:5433 \
  -e TEST_SQS_ENDPOINT=http://host.docker.internal:4567 \
  -e TEST_DOCKER_HOST=host.docker.internal \
  --entrypoint sh \
  "$BUN_IMAGE" \
  -c '
    set -eu
    apk add --no-cache docker-cli
    bun install --frozen-lockfile
    bun run typecheck
    bun run test:unit
    bun run test:integration
    bun run test:concurrency
  '
