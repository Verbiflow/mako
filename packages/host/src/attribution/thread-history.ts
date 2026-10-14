import { isAbsolute, join } from "node:path"
import {
  CarriedActivitySchema,
  ThreadFileHistorySchema,
  type CarriedActivity,
  type CarriedEffect,
  type CarriedName,
  type CarriedWrite,
  type PathMap,
  type ThreadFileHistory,
  type ThreadHistoryPart,
} from "@mako/protocol"
import type { JournalStore, StoredActivity, StoredRoot } from "./journal-store.js"
import { within } from "./paths.js"

/*
 * A Thread's file history between journals (the contract is
 * `ThreadFileHistorySchema` in @mako/protocol): written where the Thread
 * leaves, taken where it lands, through the journal's owner. A carried part
 * lives in tables of its own, never among the journal's entries and
 * activity: those decide who wrote what on this device, and a call that ran
 * on another machine wrote nothing here.
 */

/** Renames followed from one path at most; a longer chain is a loop. */
const MAX_HOPS = 16
const MAX_PATH = 4096

/** What carrying a Thread's history did. */
export interface CarryResult {
  thread: string
  /** The journals whose parts it took. */
  taken: string[]
  /** The parts it left: this journal's own, or one it already had as new or newer. */
  left: { journal: string; why: "own" | "had" }[]
  /** Picks that changed. */
  choices: number
}

/** The Thread's file history as this journal knows it: its own part, then each part carried here, to go where the Thread goes next. */
export function threadHistory(store: JournalStore, thread: string, now: number): ThreadFileHistory {
  const own = ownPart(store, thread, now)
  const saw = own.activity.length > 0 || own.writes.length > 0 || own.names.length > 0
  const parts = [...(saw ? [own] : []), ...store.carriedParts(thread).filter((part) => part.journal !== store.id)]
  return ThreadFileHistorySchema.parse({ format: 1, thread, from: store.id, parts, choices: store.choiceRows(thread) })
}

/**
 * Take a Thread's history carried from another journal, in one transaction.
 * `map`: where its paths are here, where they differ. Both are parsed where
 * they arrive: the journal's owner reads them from the file a host left.
 */
export function carryHistory(store: JournalStore, history: ThreadFileHistory, map: PathMap, now: number): CarryResult {
  const rebase = rebaser(map)
  const result: CarryResult = { thread: history.thread, taken: [], left: [], choices: 0 }
  store.transaction(() => {
    for (const part of history.parts) {
      if (part.journal === store.id) {
        result.left.push({ journal: part.journal, why: "own" })
        continue
      }
      const kept = store.carriedStamp(history.thread, part.journal)
      if (kept && (kept.through > part.through || (kept.through === part.through && kept.at >= part.at))) {
        result.left.push({ journal: part.journal, why: "had" })
        continue
      }
      store.replaceCarried(history.thread, rebasePart(part, rebase), now)
      result.taken.push(part.journal)
    }
    for (const choice of history.choices)
      if (store.mergeChoice({ thread: history.thread, spelling: choice.spelling, path: rebase(choice.path), at: choice.at })) result.choices++
  })
  return result
}

/** This journal's part: the Thread's activity, its certain writes, and the last entry along every path it used. */
function ownPart(store: JournalStore, thread: string, now: number): ThreadHistoryPart {
  const roots = store.roots()
  const byId = new Map(roots.map((root) => [root.id, root]))
  const activity = store.activityOfThread(thread).flatMap((item) => {
    const carried = CarriedActivitySchema.safeParse(carriedActivity(item))
    return carried.success ? [carried.data] : []
  })
  const writes: CarriedWrite[] = []
  for (const entry of store.entriesBy("thread", thread)) {
    const root = byId.get(entry.root)
    const certain = entry.author.certainty === "exact" || entry.author.certainty === "named"
    const path = root && join(root.path, entry.path)
    if (path && certain && entry.kind !== "delete" && path.length <= MAX_PATH) writes.push({ seq: entry.seq, at: entry.at, path })
  }
  const used = new Set<string>()
  for (const item of activity) for (const path of activityPaths(item)) used.add(path)
  for (const write of writes) used.add(write.path)
  for (const choice of store.choiceRows(thread)) used.add(choice.path)
  const names = new Map<string, CarriedName>()
  for (const path of used) followNames(store, roots, path, names)
  const folders = [...used, ...activity.flatMap((item) => [item.checkout, item.cwd].filter((folder) => folder !== undefined))]
  return {
    journal: store.id,
    device: store.device.slice(0, 200) || "unknown",
    through: store.lastSeq(),
    at: now,
    roots: roots.filter((root) => folders.some((path) => within(root.path, path))).map((root) => ({ path: root.path, repository: root.repository })),
    activity,
    writes,
    names: [...names.values()],
  }
}

/** Every path a carried call names or reports. */
function activityPaths(item: CarriedActivity): string[] {
  const paths = [...item.named]
  for (const effect of item.effects ?? []) {
    if (effect.kind === "rename") paths.push(effect.from, effect.to)
    else if (effect.kind === "command") paths.push(...(effect.named ?? []))
    else paths.push(effect.path)
  }
  return paths
}

/** The last entry at `path` and at each path a rename away from it led to. */
function followNames(store: JournalStore, roots: readonly StoredRoot[], path: string, names: Map<string, CarriedName>): void {
  const root = rootOf(roots, path)
  if (!root || path === root.path) return
  let inside = path.slice(root.path.length + 1)
  let after = 0
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    const last = store.last(root.id, inside, after)
    if (!last) return
    const at = join(root.path, inside)
    const to = last.kind === "rename" && last.from === inside ? join(root.path, last.path) : undefined
    const seen = names.get(at)
    if (to && to.length > MAX_PATH) return
    if (!seen || seen.seq < last.seq) names.set(at, to ? { seq: last.seq, at: last.at, path: at, to } : { seq: last.seq, at: last.at, path: at })
    if (!to) return
    inside = last.path
    after = last.seq
  }
}

/** A journal's activity row as a Thread's history carries it: paths made absolute, a command's text left behind. */
function carriedActivity(item: StoredActivity): CarriedActivity {
  const absolute = (path: string | undefined, cwd = item.cwd) => {
    const resolved = path === undefined ? undefined : isAbsolute(path) ? path : cwd ? join(cwd, path) : undefined
    return resolved !== undefined && resolved.length <= MAX_PATH ? resolved : undefined
  }
  const effects = (item.effects ?? []).flatMap((effect): CarriedEffect[] => {
    if (effect.kind === "rename") {
      const from = absolute(effect.from)
      const to = absolute(effect.to)
      return from && to ? [{ kind: "rename", from, to }] : []
    }
    if (effect.kind === "command") {
      const cwd = absolute(effect.cwd)
      const named = (effect.named ?? []).flatMap((path) => absolute(path, cwd ?? item.cwd) ?? []).slice(0, 256)
      return [{ kind: "command", ...(cwd && { cwd }), ...(named.length && { named }) }]
    }
    const path = absolute(effect.path)
    return path ? [{ kind: effect.kind, path }] : []
  }).slice(0, 4096)
  const carried: CarriedActivity = {
    session: item.session,
    kind: item.kind,
    id: item.id,
    start: item.start,
    end: item.end,
    named: item.named.flatMap((path) => absolute(path) ?? []).slice(0, 256),
  }
  const checkout = absolute(item.checkout)
  const cwd = absolute(item.cwd)
  if (checkout) carried.checkout = checkout
  if (cwd) carried.cwd = cwd
  if (effects.length) carried.effects = effects
  return carried
}

/** The path where `map` puts it: the longest `from` it's in, else where it was. */
function rebaser(map: PathMap): (path: string) => string {
  if (!map.length) return (path) => path
  const longest = [...map].sort((a, b) => b.from.length - a.from.length)
  return (path) => {
    const rule = longest.find((one) => within(one.from, path))
    return rule ? rule.to + path.slice(rule.from.length) : path
  }
}

function rebasePart(part: ThreadHistoryPart, rebase: (path: string) => string): ThreadHistoryPart {
  return {
    ...part,
    roots: part.roots.map((root) => ({ ...root, path: rebase(root.path) })),
    activity: part.activity.map((item) => ({
      ...item,
      ...(item.checkout && { checkout: rebase(item.checkout) }),
      ...(item.cwd && { cwd: rebase(item.cwd) }),
      named: item.named.map(rebase),
      ...(item.effects && {
        effects: item.effects.map((effect): CarriedEffect => {
          if (effect.kind === "rename") return { kind: "rename", from: rebase(effect.from), to: rebase(effect.to) }
          if (effect.kind === "command") return { kind: "command", ...(effect.cwd && { cwd: rebase(effect.cwd) }), ...(effect.named && { named: effect.named.map(rebase) }) }
          return { kind: effect.kind, path: rebase(effect.path) }
        }),
      }),
    })),
    writes: part.writes.map((write) => ({ ...write, path: rebase(write.path) })),
    names: part.names.map((name) => ({ ...name, path: rebase(name.path), ...(name.to && { to: rebase(name.to) }) })),
  }
}

function rootOf<T extends { path: string }>(roots: readonly T[], path: string): T | undefined {
  let found: T | undefined
  for (const root of roots) if (within(root.path, path) && (!found || root.path.length > found.path.length)) found = root
  return found
}