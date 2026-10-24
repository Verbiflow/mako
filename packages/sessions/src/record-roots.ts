import { createHash } from "node:crypto"
import { isAbsolute, join, relative, sep } from "node:path"
import type { RecordRoot } from "./harness-records.js"

/**
 * The record store names a path by the root it lies under and the path
 * below that root (`codex:sessions/2026/10/01/rollout-….jsonl`), never by
 * the machine's home or the root's own location. So a session kept under
 * `XDG_DATA_HOME` or `GROK_HOME` elsewhere, or on a machine with another
 * home or another operating system, has the same units.
 */

const ROOT_NAME = /^[a-z][a-z0-9-]*(?:@[0-9a-f]{8})?$/

/** A root for a folder beyond a harness's usual one, told apart by its path. */
export function extraRoot(name: string, path: string): RecordRoot {
  return { name: `${name}@${createHash("sha256").update(path).digest("hex").slice(0, 8)}`, path }
}

/** Refuses roots a key couldn't be made from: an unnamed or relative one, or two under one name. */
export function checkRoots(roots: readonly RecordRoot[]): void {
  const names = new Set<string>()
  for (const root of roots) {
    if (!ROOT_NAME.test(root.name)) throw new Error(`The record root name ${JSON.stringify(root.name)} isn't a lowercase name`)
    if (!isAbsolute(root.path)) throw new Error(`The record root ${root.name} is at ${root.path}, which isn't absolute`)
    if (names.has(root.name)) throw new Error(`Two record roots are named ${root.name}`)
    names.add(root.name)
  }
}

/** `path` as the store names it, under the deepest root holding it. */
export function qualify(roots: readonly RecordRoot[], path: string): string {
  let best: { root: RecordRoot; below: string } | undefined
  for (const root of roots) {
    const below = relative(root.path, path)
    if (!below || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) continue
    if (!best || root.path.length > best.root.path.length) best = { root, below }
  }
  if (!best) throw new Error(`${path} lies outside every folder the harness keeps records in (${roots.map((root) => root.path).join(", ") || "none"})`)
  return `${best.root.name}:${best.below.split(sep).join("/")}`
}

/** A qualified path's root name and the path below it, which must stay inside the root. */
export function splitQualified(qualified: string) {
  const colon = qualified.indexOf(":")
  const root = qualified.slice(0, colon)
  const below = qualified.slice(colon + 1)
  const parts = below.split("/")
  if (colon < 1 || !ROOT_NAME.test(root) || !below || isAbsolute(below) || parts.some((part) => part === ".." || part === "." || part === ""))
    throw new Error(`${qualified} isn't a path inside a record root`)
  return { root, below }
}

/** The absolute path of `qualified` where each root is at `folders`. */
export function placeIn(folders: ReadonlyMap<string, string>, qualified: string): string {
  const { root, below } = splitQualified(qualified)
  const folder = folders.get(root)
  if (folder === undefined) throw new Error(`No folder is known for the record root ${root}`)
  return join(folder, ...below.split("/"))
}

export function rootFolders(roots: readonly RecordRoot[]): Map<string, string> {
  return new Map(roots.map((root) => [root.name, root.path]))
}

/**
 * Where a session's roots go in a destination: as the destination names
 * them, else at the same place under the destination's home when the source
 * kept the root under its own home. A root kept elsewhere, which the
 * destination doesn't name, has nowhere to go and the restore says so.
 *
 * A path a session's records name may have been written in another home than
 * the one its layout says: a session that went to a cloud machine and back has
 * rows the machine wrote, naming its home (`/home/node/.codex/…`), under the
 * device's layout, which the cloud keeps from the session's first arrival. A
 * root under its home is known in any home by its place there (`.codex`), so a
 * path naming it in another home goes to the destination's root too.
 */
export class RootPlaces {
  readonly folders = new Map<string, string>()
  /** Roots that have no place in the destination, with why. */
  readonly missing: { root: string; reason: string }[] = []
  private readonly moves: { from: string; to: string }[] = []
  /** Each root kept under its home, by its place there (`.codex`), and where it goes: found in any home. */
  private readonly homed: { below: string; to: string }[] = []

  constructor(source: { home: string; roots: ReadonlyMap<string, string> }, destination: { home: string; roots?: readonly RecordRoot[] }) {
    const named = rootFolders(destination.roots ?? [])
    for (const [name, from] of source.roots) {
      const below = relative(source.home, from)
      const underHome = below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below)
      const to = named.get(name) ?? (underHome ? join(destination.home, below) : undefined)
      if (to === undefined) {
        this.missing.push({ root: name, reason: `The session's ${name} records were kept at ${from}, outside its home ${source.home}, and the restore names no folder for them` })
        continue
      }
      this.folders.set(name, to)
      if (to !== from) this.moves.push({ from, to })
      if (underHome && below !== "") this.homed.push({ below, to })
    }
    // A root the destination names has its place there, whether or not the session's layout kept it.
    for (const [name, to] of named) if (!this.folders.has(name)) this.folders.set(name, to)
    this.moves.sort((left, right) => right.from.length - left.from.length)
    this.homed.sort((left, right) => right.below.length - left.below.length)
  }

  place(qualified: string): string {
    return placeIn(this.folders, qualified)
  }

  /** A path into the source's own records, as it is in the destination; any other value is left as it is. */
  moved(value: string): string {
    for (const { from, to } of this.moves) {
      if (value === from) return to
      if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`
    }
    // Written in another home: the root's place under it, after an absolute home.
    if (!isAbsolute(value)) return value
    for (const { below, to } of this.homed) {
      const at = value.indexOf(`${sep}${below}`)
      if (at <= 0) continue
      const after = value.slice(at + 1 + below.length)
      if (after !== "" && !after.startsWith(sep)) continue
      return `${to}${after}`
    }
    return value
  }

  /** Whether a value naming a path may read otherwise in the destination: always, while any root has a place under its home. */
  get moving(): boolean {
    return this.moves.length > 0 || this.homed.length > 0
  }
}
