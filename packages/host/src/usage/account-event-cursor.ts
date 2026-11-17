import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { jsonStoreAccess } from "@mako/sessions/store-format"

/** Owned persistence deadlines, separate from the connection's token/heartbeat clock. */
export interface AccountEventClock {
  now(): number
  after(ms: number, run: () => void): () => void
}
export function accountEventClock(): AccountEventClock {
  return {
    now: () => Date.now(),
    after(ms, run) { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer) },
  }
}

/** The stream's identity, independent of credential rotation. No credential is kept in a cursor. */
export interface AccountEventScope { cloud: string; account: string; device: string; createdAt: string }
export interface AccountEventCursors {
  read(scope: AccountEventScope): Promise<number | undefined>
  write(scope: AccountEventScope, seen: number): Promise<void>
}

const CursorSchema = z.object({ version: z.number().int().positive(), reads: z.number().int().nonnegative().optional(), scope: z.string(), seen: z.number().int().nonnegative() }).loose()
const MAX_BYTES = 16 * 1024

function scopeKey(scope: AccountEventScope): string {
  return createHash("sha256").update(JSON.stringify([scope.cloud, scope.account, scope.device, scope.createdAt])).digest("hex")
}

/** One small atomic checkpoint per device identity, written by the host owning this data root. */
export class FileAccountEventCursors implements AccountEventCursors {
  private readonly directory: string
  private writes: Promise<void> = Promise.resolve()
  constructor(directory: string) { this.directory = directory }

  private async load(key: string) {
    const file = join(this.directory, `${key}.json`)
    try {
      if ((await stat(file)).size > MAX_BYTES) throw new Error("The account event cursor is too large")
      const saved = CursorSchema.parse(JSON.parse(await readFile(file, "utf8")))
      if (saved.scope !== key) throw new Error("The account event cursor belongs to another stream")
      if (jsonStoreAccess({ version: saved.version, reads: saved.reads ?? saved.version }, 1) === "refused") throw new Error("A newer Mako is needed to read the account event cursor")
      return saved
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }

  async read(scope: AccountEventScope): Promise<number | undefined> {
    await this.writes
    return (await this.load(scopeKey(scope)))?.seen
  }

  write(scope: AccountEventScope, seen: number): Promise<void> {
    const key = scopeKey(scope)
    const run = this.writes.then(async () => {
      const previous = await this.load(key)
      if (previous && jsonStoreAccess({ version: previous.version, reads: previous.reads ?? previous.version }, 1) !== "write") throw new Error("A newer Mako wrote this account event cursor; this one cannot change it")
      if (previous && previous.seen >= seen) return
      const saved = { ...previous, version: 1, scope: key, seen }
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = join(this.directory, `.${key}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(saved), { flag: "wx", mode: 0o600 })
        await rename(temporary, join(this.directory, `${key}.json`))
      } finally { await rm(temporary, { force: true }) }
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}

/** A fixture with no persistent profile follows the same stream rule in memory. */
export function memoryAccountEventCursors(): AccountEventCursors {
  const positions = new Map<string, number>()
  return {
    read: async scope => positions.get(scopeKey(scope)),
    write: async (scope, seen) => { const key = scopeKey(scope); positions.set(key, Math.max(positions.get(key) ?? 0, seen)) },
  }
}
