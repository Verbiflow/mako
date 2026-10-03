import { existsSync, statSync } from "node:fs"
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

let strictNativeStores = false

/**
 * From now on, open every harness's own database the way `openReadOnly`
 * does. Providers open their stores from module functions, so this is the
 * process's choice, made once by a catalog that must not write, and never
 * undone.
 */
export function restrictNativeStores(): void {
  strictNativeStores = true
}

/** A harness's database, read-only; after `restrictNativeStores`, read-only at the file level too. */
export function openNativeStore(path: string, options: ReadOnlyOpenOptions = {}): DatabaseSync {
  if (strictNativeStores) return openReadOnly(path, options).database
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
  return new DatabaseSync(path, options.timeout === undefined ? { readOnly: true } : { readOnly: true, timeout: options.timeout })
}

/** Throws `ReadOnlyStoreError` for `store` once `restrictNativeStores` ran. */
export function refuseNativeWrite(store: string): void {
  if (strictNativeStores) throw new ReadOnlyStoreError(store)
}

/** A harness's database opened to write it; refused after `restrictNativeStores`. */
export function openNativeStoreForWriting(path: string): DatabaseSync {
  refuseNativeWrite(`The harness store ${path}`)
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
  return new DatabaseSync(path)
}

/** What a held native connection must be reopened for; it changes only for a strict snapshot. */
export function nativeStoreVersion(path: string): string {
  if (!strictNativeStores) return ""
  const version = readOnlyVersion(path)
  return version === "live" ? "" : version
}
