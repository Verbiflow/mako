import type { ToolEffect } from "@mako/sessions/tool-effects"
import { COLLIDE_BURST_MS } from "../contracts/children.js"

/** A Thread another may collide with, and from when a change of either counts: the later of their starts. */
export interface Mate {
  thread: string
  since: number
}

/** Two Threads that changed the same files, as the watch holds them: every file found, oldest first, and who the pair is. */
export interface Collided {
  a: string
  b: string
  files: readonly string[]
}

export interface FinCollisionsDeps {
  now(): number
  /** A timer that runs `run` once after `ms`, and its cancel. */
  later(ms: number, run: () => void): () => void
  /**
   * The open Threads `thread` may collide with: its Apex, its Apex's other Fins and its own Fins, each with the later of
   * the two starts. None for a Thread in no Shiver, which then costs this one call a write and keeps nothing.
   */
  mates(thread: string): Mate[]
  /** `a` and `b` each changed `files`, new since the pair was last said; `first`: it wasn't said before. */
  collided(a: string, b: string, files: readonly string[], first: boolean): void
  burstMs?: number
}

/** Files held with their writers: past it the one written longest ago goes, and a collision there waits for both to write it again. */
const FILES_KEPT = 4_096
/** Files a pair is told of: one past it has said what there is to say. */
const PAIR_FILES = 512

interface Pair extends Collided {
  files: string[]
  seen: Set<string>
  /** Found since the pair was last said, for the burst's one notice. */
  fresh: string[]
  told: boolean
  cancel?: () => void
}

/**
 * The files a finished call states it wrote: created, changed, written, deleted or renamed by the tool itself. What its
 * harness only saw change while it ran (`seen`) may be another Thread's write, and a command names no file it wrote, so
 * neither counts: a collision is never one Thread's change read as two.
 */
export function statedWrites(effects: readonly ToolEffect[]): string[] {
  const paths: string[] = []
  for (const effect of effects) {
    if ("seen" in effect && effect.seen) continue
    if (effect.kind === "create" || effect.kind === "modify" || effect.kind === "write" || effect.kind === "delete") paths.push(effect.path)
    else if (effect.kind === "rename") paths.push(effect.from, effect.to)
  }
  return paths
}

/**
 * Notices two Threads of one Shiver changing the same file. Each stated write stamps its file with its writer, a map
 * write; only a file a second writer stamps is looked at, and it's a collision when the other's last write there is no
 * older than the later of the two starts. Files are absolute paths, so a Fin in its own worktree never collides with
 * one in another folder: the same file there is another path until a merge. A pair's files found within a burst are
 * said together, each file once a pair. No file is watched or read, and nothing is kept for a Thread with no mate.
 */
export class FinCollisions {
  private readonly deps: FinCollisionsDeps
  private readonly burstMs: number
  /** Each file's writers and when each last wrote it, the file written longest ago first. */
  private readonly writers = new Map<string, Map<string, number>>()
  private readonly pairs = new Map<string, Pair>()
  /** Each Thread's pairs, oldest first: what its row reads. */
  private readonly byThread = new Map<string, Pair[]>()
  private stopped = false

  constructor(deps: FinCollisionsDeps) {
    this.deps = deps
    this.burstMs = deps.burstMs ?? COLLIDE_BURST_MS
  }

  /** `thread` wrote `paths` now. */
  wrote(thread: string, paths: readonly string[]): void {
    if (this.stopped || !paths.length) return
    const mates = this.deps.mates(thread)
    if (!mates.length) return
    const at = this.deps.now()
    for (const path of paths) {
      const by = this.writers.get(path) ?? new Map<string, number>()
      // Written last, so kept longest.
      this.writers.delete(path)
      this.writers.set(path, by)
      by.set(thread, at)
      if (by.size === 1) continue
      for (const mate of mates) {
        const theirs = by.get(mate.thread)
        if (theirs !== undefined && theirs >= mate.since) this.found(thread, mate.thread, path)
      }
    }
    while (this.writers.size > FILES_KEPT) this.writers.delete(this.writers.keys().next().value!)
  }

  /** The pairs `thread` is in, oldest first; none for a Thread that never collided. */
  of(thread: string): readonly Collided[] {
    return this.byThread.get(thread) ?? []
  }

  /** How many files are held with their writers: what a test reads to see that nothing is kept. */
  get held(): number {
    return this.writers.size
  }

  stop(): void {
    this.stopped = true
    for (const pair of this.pairs.values()) pair.cancel?.()
  }

  /** The two as one pair, whichever wrote last. */
  private pair(one: string, other: string): Pair {
    const [a, b] = one < other ? [one, other] : [other, one]
    const key = `${a}\n${b}`
    const held = this.pairs.get(key)
    if (held) return held
    const pair: Pair = { a, b, files: [], seen: new Set(), fresh: [], told: false }
    this.pairs.set(key, pair)
    for (const thread of [a, b]) this.byThread.set(thread, [...this.byThread.get(thread) ?? [], pair])
    return pair
  }

  private found(one: string, other: string, path: string): void {
    const pair = this.pair(one, other)
    if (pair.seen.has(path) || pair.seen.size >= PAIR_FILES) return
    pair.seen.add(path)
    pair.files.push(path)
    pair.fresh.push(path)
    // One notice a burst: the first file found starts its window, and the rest found within it go with it.
    pair.cancel ??= this.deps.later(this.burstMs, () => this.say(pair))
  }

  private say(pair: Pair): void {
    pair.cancel = undefined
    if (this.stopped) return
    const files = pair.fresh
    const first = !pair.told
    pair.fresh = []
    pair.told = true
    this.deps.collided(pair.a, pair.b, files, first)
  }
}
