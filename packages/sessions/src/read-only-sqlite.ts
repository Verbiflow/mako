import { existsSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { z } from "zod"

/**
 * How a connection that must never write opens a WAL database another
 * process may be writing.
 *
 * `readOnly` alone still maps `-shm` read-write, and a connection that is
 * first to attach truncates and rebuilds it, creating `-wal` and `-shm` when
 * they are missing. `readonly_shm=1` maps an existing `-shm` read-only and
 * follows the writer's index, so commits stay visible ("live"). It cannot
 * open at all without `-shm`; but then no process has the database open, and
 * the last one to close moved every commit into the main file, so that file
 * is read `immutable`, which locks and creates nothing ("snapshot"), and
 * reopened once it changes or a writer appears. A `-wal` a crashed writer
 * left without `-shm` is not read until its owner opens the database again.
 * SQLite opens an existing `-wal` read-write whenever it reads it
 * (`sqlite3WalOpen` asks for READWRITE|CREATE); a read-only connection never
 * writes to it.
 */
export type ReadOnlyAccess = "live" | "snapshot"

export class ReadOnlyStoreError extends Error {
  constructor(store: string) {
    super(`${store} is open read-only in this host; nothing was written`)
    this.name = "ReadOnlyStoreError"
  }
}

export interface ReadOnlyOpenOptions {
  /** SQLite's busy timeout, in milliseconds. */
  timeout?: number
}

export interface OpenedReadOnly {
  database: DatabaseSync
  access: ReadOnlyAccess
  /** `readOnlyVersion` when it opened; a different one means a snapshot is stale. */
  version: string
}

const CantOpenSchema = z.object({ errcode: z.literal(14) })

/** "live" while another connection keeps `-wal` and `-shm`; otherwise the main file's identity, size and time. */
export function readOnlyVersion(path: string): string {
  if (existsSync(`${path}-shm`) && existsSync(`${path}-wal`)) return "live"
  const info = statSync(path, { throwIfNoEntry: false })
  return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` : "missing"
}

/** Open `path` without writing or creating any file; throws when it does not exist. */
export function openReadOnly(path: string, options: ReadOnlyOpenOptions = {}): OpenedReadOnly {
  const version = readOnlyVersion(path)
  if (version === "live") {
    try {
      return { database: connect(path, "live", options), access: "live", version }
    } catch (error) {
      // The last writer closed between the check and the open, taking `-shm` with it.
      if (!CantOpenSchema.safeParse(error).success) throw error
    }
  }
  return { database: connect(path, "snapshot", options), access: "snapshot", version: readOnlyVersion(path) }
}

function connect(path: string, access: ReadOnlyAccess, options: ReadOnlyOpenOptions): DatabaseSync {
  const location = pathToFileURL(path)
  location.searchParams.set("mode", "ro")
  location.searchParams.set(access === "live" ? "readonly_shm" : "immutable", "1")
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
  const database = new DatabaseSync(location, options.timeout === undefined ? { readOnly: true } : { readOnly: true, timeout: options.timeout })
  try {
    // SQLite maps `-wal` and `-shm` on the first read, not on open.
    database.prepare("PRAGMA schema_version").get()
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

/**
 * A long-lived read-only connection. A live one follows every commit itself.
 * A snapshot sees nothing written after it opened, so `refresh` reopens it
 * once the file has changed or a writer has the database open.
 */
export class ReadOnlyConnection {
  readonly path: string
  private readonly options: ReadOnlyOpenOptions
  private opened: OpenedReadOnly

  constructor(path: string, options: ReadOnlyOpenOptions = {}) {
    this.path = path
    this.options = options
    this.opened = openReadOnly(path, options)
  }

  get database(): DatabaseSync {
    return this.opened.database
  }

  get access(): ReadOnlyAccess {
    return this.opened.access
  }

  /** Reopen a stale snapshot; true when `database` is a new connection. */
  refresh(): boolean {
    if (this.opened.access === "live" || readOnlyVersion(this.path) === this.opened.version) return false
    const next = openReadOnly(this.path, this.options)
    this.opened.database.close()
    this.opened = next
    return true
  }

  close(): void {
    this.opened.database.close()
  }
}

/**
 * How one host opens the harnesses' own databases. A strict host, one that
 * must not write (the fixture desk), opens each the way `openReadOnly` does
 * and refuses every write; otherwise a store opens with SQLite's `readOnly`,
 * which may map its `-shm` and make `-wal`, and may be written. Whoever reads
 * or writes a harness's store is handed its host's.
 */
export class NativeStores {
  readonly strict: boolean
  readonly ownFolder: string | undefined

  /** `ownFolder`: a folder of Mako's own, where strict stores still open databases to write. */
  constructor(strict: boolean, ownFolder?: string) {
    this.strict = strict
    this.ownFolder = ownFolder === undefined ? undefined : resolve(ownFolder)
  }

  /** A harness's database, read-only; when strict, read-only at the file level too. */
  open(path: string, options: ReadOnlyOpenOptions = {}): DatabaseSync {
    if (this.strict) return openReadOnly(path, options).database
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
    return new DatabaseSync(path, options.timeout === undefined ? { readOnly: true } : { readOnly: true, timeout: options.timeout })
  }

  /** Throws `ReadOnlyStoreError` for `store` when strict. */
  refuseWrite(store: string): void {
    if (this.strict) throw new ReadOnlyStoreError(store)
  }

  /** A harness's database opened to write it; refused when strict, unless it is in the stores' own folder. */
  openForWriting(path: string): DatabaseSync {
    const inside = this.ownFolder === undefined ? null : relative(this.ownFolder, resolve(path))
    if (inside === null || inside.startsWith("..") || isAbsolute(inside)) this.refuseWrite(`The harness store ${path}`)
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
    return new DatabaseSync(path)
  }

  /** What a held connection must be reopened for; it changes only for a strict snapshot. */
  version(path: string): string {
    if (!this.strict) return ""
    const version = readOnlyVersion(path)
    return version === "live" ? "" : version
  }
}
