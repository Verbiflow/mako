import type { ForkIds, RecordFork, RecordValue } from "../harness-records.js"
import { base62, mapText, ownedBy, replaceQuoted } from "../record-fork.js"

/**
 * An OpenCode session written again as its own fork, as `Session.fork`
 * writes one: a session row under a new id naming the session it was forked
 * from (`session_v2.fork_session_id`) and titled as OpenCode titles a fork
 * ("… (fork #1)"), and the session's messages copied under new ids, their
 * contents as they were. A store from OpenCode 1 (`session`, `message`,
 * `part`) keeps no fork column, so there the title is what says so, and a
 * message's or part's references to another (`parentID`) follow the new
 * ids. The session's instruction state, todos, pending and inbox items and
 * event sequence follow it; the project, instruction blobs, a share link and
 * the migration lists stay the store's. Child sessions stay the source's.
 */
/** The store's own tables, which no session owns: the project, instruction blobs, share links, the migration lists. */
const OPENCODE_STORE_TABLES = new Set(["project", "instruction_blob", "session_share", "migration", "__drizzle_migrations"])

export const openCodeFork: RecordFork = {
  id: (seed, from) => openCodeId(seed, from),
  file: () => null,
  table(name, table, ids) {
    if (!/^opencode[^:]*:[^/]+\.db$/.test(name)) return null
    switch (table) {
      case "session_v2":
      case "session":
        return ownedBy("id", ids, {
          title: (value) => mapText(value, forkTitle),
          fork_session_id: () => ids.from,
          revert: (value) => renamedIds(value, ids),
        })
      case "session_message":
        return ownedBy("session_id", ids, { id: (value) => derivedId(value, ids) })
      case "message":
        return ownedBy("session_id", ids, { id: (value) => derivedId(value, ids), data: (value) => renamedIds(value, ids) })
      case "part":
        return ownedBy("session_id", ids, { id: (value) => derivedId(value, ids), message_id: (value) => derivedId(value, ids), data: (value) => renamedIds(value, ids) })
      case "session_pending":
      case "session_inbox":
        return ownedBy("session_id", ids, { id: (value) => derivedId(value, ids) })
      case "event_sequence":
        return ownedBy("aggregate_id", ids)
      case "event":
        return ownedBy("aggregate_id", ids, { id: (value) => derivedId(value, ids), data: (value) => mapText(value, (data) => replaceQuoted(Buffer.from(data), ids.from, ids.to).toString("utf8")) })
      default:
        return OPENCODE_STORE_TABLES.has(table) ? "shared" : ownedBy("session_id", ids)
    }
  },
  storeTable: (name, table) => /^opencode[^:]*:[^/]+\.db$/.test(name) && OPENCODE_STORE_TABLES.has(table),
}

/** OpenCode's own fork title: "X (fork #1)", or the next number for a fork of a fork. */
function forkTitle(title: string): string {
  const numbered = /^(.+) \(fork #(\d+)\)$/.exec(title)
  return numbered ? `${numbered[1]} (fork #${Number.parseInt(numbered[2] ?? "0", 10) + 1})` : `${title} (fork #1)`
}

const ID = /^([a-z]+)_([0-9a-f]{12})/

/** An id of OpenCode's shape (`msg_<12 hex of time><14 base 62>`) for `name`, keeping its kind and time, so messages and parts sort as the source's do. */
function openCodeId(bytes: Buffer, name: string): string {
  const parts = ID.exec(name)
  const [, kind = name.slice(0, name.indexOf("_")) || "id", time = bytes.toString("hex").slice(0, 12)] = parts ?? []
  return `${kind}_${time}${base62(bytes.subarray(6), 14)}`
}

function derivedId(value: RecordValue, ids: ForkIds): RecordValue {
  return mapText(value, (id) => openCodeId(ids.derive(id), id))
}

/** A JSON value with every message and part id it names (`parentID`, a revert's `messageID`) made the fork's. */
function renamedIds(value: RecordValue, ids: ForkIds): RecordValue {
  return mapText(value, (json) => json.replace(/"((?:msg|prt)_[0-9A-Za-z_]+)"/g, (_, id: string) => JSON.stringify(openCodeId(ids.derive(id), id))))
}
