import type { ForkIds, RecordFork, RecordValue } from "../harness-records.js"
import { mapText, ownedBy, replaceQuoted, rootAndBelow, textOf, uuidFrom } from "../record-fork.js"
import { rolloutName } from "./codex-rollouts.js"

/**
 * A Codex thread written again as a fork that copied its source's rollout,
 * as Codex writes one (`session_meta.forked_from_id` with no `history_base`
 * of its own): the rollout under a new thread id in the same folder, its
 * `session_meta` naming the new id and the thread it was forked from, and
 * every record that names the thread naming the fork. The thread's rows in
 * the state, goals and queue databases and its `session_index.jsonl` lines
 * follow under the new id. The agents it spawned stay the source's: each
 * child names one parent (`thread_spawn_edges.child_thread_id` is the key).
 */
export const codexFork: RecordFork = {
  // A v7 id keeping the source's time, so the fork sorts beside it.
  id: (seed, from) => uuidFrom(seed, 7, from),
  file(path, ids) {
    const { root, below } = rootAndBelow(path)
    if (below === "session_index.jsonl") return { path, line: (line) => replaceQuoted(line, ids.from, ids.to) }
    const name = rolloutName(below)
    // `rollouts/<name>` is how the store keys a rollout wherever Codex files it: a destination's rollout Mako never saw is named so.
    if (!name || !/^(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions|rollouts)\/[^/]+$/.test(below)) return null
    if (name.thread !== ids.from) return "shared"
    return { path: `${root}:${forkRolloutPath(below, ids)}`, line: (line, index) => (index === 0 ? forkedMeta(line, ids) : replaceQuoted(line, ids.from, ids.to)) }
  },
  table(name, table, ids) {
    if (!/^codex:(?:state|goals|queue)_\d+\.sqlite$/.test(name)) return null
    if (codexFork.storeTable?.(name, table)) return "shared"
    if (table === "threads") return ownedBy("id", ids, { rollout_path: (value) => mapText(value, (path) => forkRolloutPath(path, ids)) })
    // A child names one parent, so the fork takes only the edge that makes the thread itself a child.
    if (table === "thread_spawn_edges") return ownedBy("child_thread_id", ids)
    if (table === "thread_attachments" || table === "queued_items") return ownedBy("thread_id", ids, { id: (value) => derivedId(value, ids) })
    return ownedBy("thread_id", ids)
  },
  // The migration list is the database's, whichever store made it.
  storeTable: (name, table) => /^codex:(?:state|goals|queue)_\d+\.sqlite$/.test(name) && table === "_sqlx_migrations",
}

/** A rollout's path, its name naming the fork's thread, and a revert's own rollout id one of the fork's. */
function forkRolloutPath(path: string, ids: ForkIds): string {
  const slash = path.lastIndexOf("/")
  const name = rolloutName(path.slice(slash + 1))
  if (!name || name.thread !== ids.from) return path
  let renamed = path.slice(slash + 1).replace(`-${ids.from}`, `-${ids.to}`)
  if (name.rollout !== name.thread) renamed = renamed.replace(`_${name.rollout}`, `_${uuidFrom(ids.derive(name.rollout), 7, name.rollout)}`)
  return `${path.slice(0, slash + 1)}${renamed}`
}

/** The first record, `session_meta`, naming the fork and the thread it was forked from, where Codex puts `forked_from_id`: after `id`. */
function forkedMeta(line: Buffer, ids: ForkIds): Buffer {
  const renamed = replaceQuoted(line, ids.from, ids.to)
  const text = renamed.toString("utf8")
  const earlier = /"forked_from_id":("[^"]*"|null)/.exec(text)
  if (earlier) return Buffer.from(`${text.slice(0, earlier.index)}"forked_from_id":${JSON.stringify(ids.from)}${text.slice(earlier.index + earlier[0].length)}`)
  const named = `"id":${JSON.stringify(ids.to)}`
  const at = text.indexOf(named)
  if (at === -1) return renamed
  return Buffer.from(`${text.slice(0, at + named.length)},"forked_from_id":${JSON.stringify(ids.from)}${text.slice(at + named.length)}`)
}

/** A row's own id the fork can't share with the source's row: a UUID keeping its version and time, or else as many hex digits. */
function derivedId(value: RecordValue, ids: ForkIds): RecordValue {
  const text = textOf(value)
  if (text === null) return value
  return derivedText(text, ids)
}

function derivedText(value: string, ids: ForkIds): string {
  const bytes = ids.derive(value)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return uuidFrom(bytes, value[14] === "7" ? 7 : 4, value)
  return bytes.toString("hex").repeat(Math.ceil(value.length / 64)).slice(0, value.length)
}
