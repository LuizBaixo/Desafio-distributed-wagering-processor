FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Runtime sem root (usuário "bun" já existe na imagem oficial).
USER bun

EXPOSE 3000

CMD ["bun", "run", "src/main.ts"]
