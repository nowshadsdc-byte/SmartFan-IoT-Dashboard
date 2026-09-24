import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// The hub and the web app write to the same SQLite file: use WAL and wait on
// locks instead of failing with SQLITE_BUSY. Run once per process.
const globalForPragma = globalThis as unknown as { sqlitePragmaDone?: boolean }
if (!globalForPragma.sqlitePragmaDone) {
  globalForPragma.sqlitePragmaDone = true
  db.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
    .then(() => db.$queryRawUnsafe('PRAGMA busy_timeout=5000;'))
    .catch((err) => console.error('[db] failed to set SQLite pragmas:', err))
}
