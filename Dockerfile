FROM oven/bun:1.3.6-alpine AS dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS builder

COPY . .
RUN bunx prisma generate
RUN bun run build

# One-shot schema sync (docker compose service "migrate"): creates/updates the
# SQLite tables on a fresh or existing volume before the app and hub start.
FROM dependencies AS migrate

ENV DATABASE_URL=file:/app/data/dev.db
RUN apk add --no-cache openssl \
    && mkdir -p /app/data \
    && chown 1001:1001 /app/data
COPY prisma ./prisma
# Runs as root (prisma may need to fetch its engine), then hands the DB file to uid 1001,
# the user the frontend and hub containers run as.
CMD ["sh", "-c", "bunx prisma db push --skip-generate && chown -R 1001:1001 /app/data"]

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DATABASE_URL=file:/app/data/dev.db

RUN apk add --no-cache openssl \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/data \
    && chown nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
