# Build context is the REPO ROOT (see docker-compose.yml) so the root Prisma schema is available.
FROM oven/bun:1.3.6-alpine

WORKDIR /app

RUN apk add --no-cache openssl \
    && addgroup -S -g 1001 hub \
    && adduser -S -u 1001 -G hub hub \
    && mkdir -p /app/data \
    && chown hub:hub /app/data

COPY mini-services/iot-hub/package.json ./
RUN bun install

# Prisma client generated from the root schema (same schema the frontend uses).
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN bunx prisma generate --schema ./prisma/schema.prisma

COPY mini-services/iot-hub/index.ts ./

ENV DATABASE_URL=file:/app/data/dev.db
ENV PORT=3003

USER hub

EXPOSE 3003

CMD ["bun", "index.ts"]
