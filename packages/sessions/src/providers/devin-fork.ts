import type { RecordFork } from "../harness-records.js"
import { mapText, ownedBy, uuidFrom } from "../record-fork.js"

/**
 * A Devin session written again as its own fork, as Devin writes one: a
 * `sessions` row under a new id titled "… (fork)", and every row the session
 * owns by `session_id` (its message nodes, tool call state, subagent heads,
 * prompts) under that id. Node ids are the session's own (`node_id`,
 * `main_chain_id`), so they're kept; a row's `row_id` is numbered by Devin's
 * database as the fork's rows are added. The migration list stays the
 * store's.
 */
export const devinFork: RecordFork = {
  // The shape Mako gives the sessions it writes for Devin: `mako-` and the start of a UUID.
  id: (seed) => `mako-${uuidFrom(seed, 4).slice(0, 13)}`,
  file: () => null,
  table(name, table, ids) {
    if (!/^devin-cli[^:]*:sessions\.db$/.test(name)) return null
    if (devinFork.storeTable?.(name, table)) return "shared"
    if (table === "sessions") return ownedBy("id", ids, { title: (value) => mapText(value, (title) => `${title} (fork)`) })
    return ownedBy("session_id", ids)
  },
  storeTable: (name, table) => /^devin-cli[^:]*:sessions\.db$/.test(name) && table === "refinery_schema_history",
}
