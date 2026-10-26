import type { FileWriters, RewindWriter } from "../contracts/workspace-snapshots.js"
import { within } from "./paths.js"
import { side, type JournalView } from "./queries.js"

/**
 * Who changed each of `paths` (absolute) since `since`, from the journal:
 * every writer of an entry made then, a Thread once however many entries it
 * made, sure when any of them is its own as `side` reads it (the same
 * reading a turn's own and maybe lines take, `turnChanges`). What Git or
 * Mako itself wrote names nobody. A rewind's preview shows it, so the person
 * sees whose work a whole-workspace restore takes back.
 */
export function writersSince(view: JournalView, paths: readonly string[], since: number): FileWriters {
  const roots = view.store.roots().filter((root) => root.active)
  const out: FileWriters = {}
  for (const path of paths) {
    const root = roots.filter((candidate) => within(candidate.path, path) && candidate.path !== path).sort((left, right) => right.path.length - left.path.length)[0]
    if (!root) continue
    const threads = new Map<string, boolean>()
    let person = false
    let unknown = false
    for (const entry of view.store.chain(root.id, path.slice(root.path.length + 1))) {
      if (entry.changedAt < since || entry.git) continue
      const author = view.author(entry.seq) ?? entry.author
      switch (author.certainty) {
        case "exact":
        case "named":
        case "window":
        case "ambiguous": {
          const named = author.certainty === "ambiguous" ? author.candidates.map((candidate) => candidate.thread) : [author.author.thread]
          if (!named.length) unknown = true
          for (const thread of named) threads.set(thread, (threads.get(thread) ?? false) || side(author, thread) === "thread")
          break
        }
        case "person":
          person = true
          break
        case "mako":
          break
      }
    }
    const writers: RewindWriter[] = [...threads].map(([thread, sure]) => ({ kind: "thread", thread, sure }))
    if (person) writers.push({ kind: "person" })
    if (unknown) writers.push({ kind: "unknown" })
    out[path] = writers
  }
  return out
}
