import { join } from "node:path"
import { archiveStanding, keptOutputsStanding } from "@mako/sessions"
import { recordStoreStanding } from "@mako/sessions/record-store"
import { UNREAD_INDEX_FILE, unreadIndexStanding } from "@mako/sessions/unread-index"
import { inspectStoreFormat, storeAccess, type StoreStanding } from "@mako/sessions/store-format"
import { hostWarn } from "../base/host-log.js"
import type { SharedStore, StoreFormats, StoreStandingRow } from "../contracts/store-formats.js"
import { SESSION_MEMORY_SCHEMA, type SessionMemory } from "./session-memory.js"
import { THREAD_STORE_SCHEMA, type ThreadStore } from "./store.js"

/** Where each shared store is, and the two this host keeps open. */
export interface StoreFormatSources {
  /** Open, its standing follows a newer Mako's change made since; null when it didn't open, and its file is read instead. */
  threads: ThreadStore | null
  threadsPath: string
  memory: SessionMemory | null
  memoryPath: string
  /** The record store's folder, the views folder and the archive's folder. */
  records: string
  views: string
  archive: string
}

/**
 * Every shared store's format for this build, read without writing. Each
 * store is asked on its own: one that can't be read is left out and logged,
 * never a reason the others aren't listed.
 */
export function storeFormats(sources: StoreFormatSources): StoreFormats {
  const stores: StoreStandingRow[] = []
  const add = (store: SharedStore, read: () => StoreStanding) => {
    try {
      stores.push(standingRow(store, read()))
    } catch (error) {
      hostWarn("stores", "a shared store's format could not be read", { store, error: error instanceof Error ? error.message : String(error) })
    }
  }
  add("threads", () => sources.threads?.standing() ?? fileStanding(sources.threadsPath, THREAD_STORE_SCHEMA))
  add("session-memory", () => sources.memory?.standing() ?? fileStanding(sources.memoryPath, SESSION_MEMORY_SCHEMA))
  add("records", () => recordStoreStanding(sources.records))
  add("unread", () => unreadIndexStanding(join(sources.views, UNREAD_INDEX_FILE)))
  add("outputs", () => keptOutputsStanding(join(sources.archive, "outputs.sqlite")))
  add("archive", () => archiveStanding(sources.archive))
  return { stores }
}

/** A store this host didn't open, read from its file. */
function fileStanding(path: string, build: number): StoreStanding {
  const format = inspectStoreFormat(path, "store_meta")
  return format ? { access: storeAccess(format, build), build, format } : { access: "write", build }
}

function standingRow(store: SharedStore, standing: StoreStanding): StoreStandingRow {
  const row: StoreStandingRow = { store, access: standing.access, build: standing.build }
  const format = standing.format
  if (!format) return row
  row.writableBy = format.writableBy
  row.readableBy = format.readableBy
  if (format.writtenBy) row.writtenBy = format.writtenBy
  if (format.readableFrom) row.readableFrom = format.readableFrom
  return row
}

/** A digest of what the window shows of the formats, so a follower tells the windows only when it changes. */
export function formatsKey(formats: StoreFormats): string {
  return JSON.stringify(formats.stores.filter((row) => row.access !== "write"))
}
