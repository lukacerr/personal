FROM oven/bun:1.3.8 AS bun

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/native/package.json apps/native/package.json
COPY apps/web/package.json apps/web/package.json

RUN bun install --frozen-lockfile --filter '!./' --filter @personal/web

COPY apps/web apps/web

ARG VITE_API_URL=http://localhost:8080
ENV VITE_API_URL=$VITE_API_URL

RUN bun run build:web

FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/build/client /usr/share/nginx/html

EXPOSE 8080
