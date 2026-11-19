import { existsSync } from "node:fs"
import { join } from "node:path"
import { gitFileText } from "@mako/git"
import { ownBytes } from "./worktree-carry.js"

const OBJECT_ID = /^[a-f0-9]{40,64}$/

/**
 * The commits of several refs every checkout of a repository shares, from the files under `commonDir`: each ref's own
 * file, and `packed-refs` read once for all that have none (`storedRef` reads it once a ref). A ref that isn't there
 * is left out. Undefined when the files can't say and Git must be asked: a reftable repository, a ref that names
 * another ref, a file that can't be read.
 */
export async function storedRefs(commonDir: string, refs: readonly string[]): Promise<Map<string, string> | undefined> {
  if (existsSync(join(commonDir, "reftable"))) return undefined
  const found = new Map<string, string>()
  const packed: string[] = []
  const loose = await Promise.all(refs.map((ref) => (ref.startsWith("refs/") && !ref.split("/").includes("..") ? gitFileText(join(commonDir, ref)) : undefined)))
  for (const [index, ref] of refs.entries()) {
    const text = loose[index]
    if (text === undefined) return undefined
    if (text === null) packed.push(ref)
    else if (OBJECT_ID.test(text)) found.set(ref, text)
    else return undefined
  }
  if (!packed.length) return found
  const text = await gitFileText(join(commonDir, "packed-refs"))
  if (text === undefined) return undefined
  // One ref a line, its commit before its name; a tag's peeled line and the header name no ref this way.
  const lines = `\n${text ?? ""}\n`
  for (const ref of packed) {
    const at = lines.indexOf(` ${ref}\n`)
    if (at < 0) continue
    const commit = lines.slice(lines.lastIndexOf("\n", at) + 1, at)
    if (!OBJECT_ID.test(commit)) return undefined
    found.set(ref, commit)
  }
  return found
}

/** A size answers for this long whatever its checkout's stamp says: an edit moves neither its HEAD nor its index. */
const SIZE_MAX_AGE_MS = 24 * 60 * 60_000
/** Checkouts measured at once: each is a walk of every file in one, in the background band. */
const SIZES_AT_ONCE = 2

interface Sized {
  stamp: string
  bytes: number | null
  at: number
}

/**
 * Each checkout's own size on disk, measured only when someone looks (Settings › Worktrees), behind the answer, and
 * kept until the checkout changes (`stamp`: its HEAD and its index's time). A list of a hundred worktrees walked every
 * file of every one before it answered, each time it was opened.
 */
export class WorktreeSizes {
  private readonly held = new Map<string, Sized>()
  private readonly wanted = new Map<string, { stamp: string; skipped: readonly string[] }>()
  private running = 0
  private readonly measure: (path: string, skipped: readonly string[]) => Promise<number | null>
  private readonly said: () => void
  private idle: Promise<void> = Promise.resolve()
  private settle: (() => void) | undefined

  constructor(said: () => void, measure: (path: string, skipped: readonly string[]) => Promise<number | null> = ownBytes) {
    this.said = said
    this.measure = measure
  }

  /**
   * The size held for `path` while its `stamp` is the one it was measured at; null until it's measured, which this
   * asks for and `begin` starts: `said` is called once it and the others asked for with it are measured.
   */
  of(path: string, stamp: string, skipped: readonly string[], now = Date.now()): number | null {
    const known = this.held.get(path)
    if (known && known.stamp === stamp && now - known.at < SIZE_MAX_AGE_MS) return known.bytes
    if (!this.wanted.size && !this.running) this.idle = new Promise((resolve) => { this.settle = resolve })
    this.wanted.set(path, { stamp, skipped })
    return null
  }

  /** Measures what `of` asked for, once the answer that asked is on its way: nothing is walked ahead of it. */
  begin(): void {
    if (this.wanted.size) setImmediate(() => this.next())
  }

  /** Forgets every size but those of `paths`. */
  keep(paths: ReadonlySet<string>): void {
    for (const path of this.held.keys()) if (!paths.has(path)) this.held.delete(path)
  }

  /** Resolves once nothing is being measured or waiting to be. */
  settled(): Promise<void> {
    return this.idle
  }

  private next(): void {
    while (this.running < SIZES_AT_ONCE) {
      const [path, want] = this.wanted.entries().next().value ?? []
      if (path === undefined || !want) break
      this.wanted.delete(path)
      this.running++
      void this.measure(path, want.skipped).catch(() => null).then((bytes) => {
        this.held.set(path, { stamp: want.stamp, bytes, at: Date.now() })
        this.running--
        if (this.running || this.wanted.size) return this.next()
        this.said()
        this.settle?.()
      })
    }
  }
}
