FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Depois do install: com NODE_ENV=production o bun pula devDependencies (inclui @mikro-orm/cli).
# Sem NODE_ENV definido, a validação de produção falharia aberta. Compose de dev sobrescreve para development.
ENV NODE_ENV=production

COPY . .

# Runtime sem root (usuário "bun" já existe na imagem oficial).
USER bun

EXPOSE 3000

CMD ["bun", "run", "src/main.ts"]
