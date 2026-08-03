FROM oven/bun:1.3.8 AS bun

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/native/package.json apps/native/package.json
COPY apps/web/package.json apps/web/package.json

RUN bun install --frozen-lockfile --filter '!./' --filter @personal/api --filter @personal/web
