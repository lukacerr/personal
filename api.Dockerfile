FROM oven/bun:1.3.8 AS build

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN bun install --frozen-lockfile --production --filter @personal/api

COPY apps/api/src apps/api/src

RUN bun run build:api

FROM gcr.io/distroless/base-debian12:nonroot

WORKDIR /app

COPY --from=build /app/apps/api/dist/server ./server

ENV PORT=8080
EXPOSE 8080
ENV NODE_ENV=production

CMD ["./server"]
