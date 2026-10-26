import { isAbsolute, join, normalize, relative, sep } from "node:path"
import type { FileCandidate, FileResolution, ResolveReason, Touch, TouchKind } from "../contracts/file-references.js"
import type { SuffixIndex } from "./suffix-index.js"

export type { FileResolution, Touch, TouchKind }
/** A root the Thread's files sit in: a checkout of a repository, or another folder it worked in. */
export interface Place {
  root: string
  /** What the person calls it: the repository's folder name. */
  name: string
  /** The repository it's a checkout of; two checkouts of one repository are twins. */
  repository?: string
  /** The Thread works here now. */
  current: boolean
  /** A checkout the Thread was in that's since gone, such as a removed worktree: its twin is the current checkout of the same name. */
  gone?: boolean
  /** Its files by the end of their paths, relative to `root`, where the journal tracks it. */
  index?: SuffixIndex
}

/** What the Thread knows that tells which file a spelling meant. */
export interface ReferenceContext {
  /** The folders its calls ran in, latest first, then the conversation's own. */
  folders: readonly string[]
  /** The files it touched, by absolute path, each with its strongest touch. */
  touched: ReadonlyMap<string, Touch>
  places: readonly Place[]
  /** Where a file renamed since is now, following every rename. */
  renamed(path: string): string | undefined
  home: string
  /** The files the person picked among several, by spelling without its line. */
  chosen?: ReadonlyMap<string, string>
}

/** A spelling's file path without its line or column (`a.ts:12:5`, `a.ts#L3-L9`). */
export function spellingPath(spelling: string): string {
  return spelling.trim().replace(/#L\d+(?:-L?\d+)?$/, "").replace(/(?::\d+){1,2}$/, "")
}

/** The line a spelling names (`a.ts:12`, `a.ts:12:5`, `a.ts#L12-L20`), from 1; undefined when it names none. */
export function spellingLine(spelling: string): number | undefined {
  const found = /(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/.exec(spelling.trim())
  const line = Number(found?.[1] ?? found?.[2])
  return Number.isSafeInteger(line) && line > 0 ? line : undefined
}

const segmentsOf = (path: string) => path.split(/[\\/]/).filter((part) => part && part !== ".")

interface Draft {
  path: string
  was?: string
  folder: number
  reason: ResolveReason
}

/**
 * Every absolute path `spelling` could mean, before any is checked on disk:
 * the person's pick; itself when absolute; from each folder the Thread was
 * in (a bare name only where it touched it); each file it touched that ends
 * the same way; and each file in its places that does (a bare name only
 * where it works now). Each is followed through renames and into the
 * checkout the Thread works in now.
 */
export function candidatesOf(spelling: string, context: ReferenceContext): Draft[] {
  const path = spellingPath(spelling)
  if (!path || path.length > 4_096) return []
  const drafts: Draft[] = []
  const add = (draft: Draft) => {
    for (const followed of follow(draft, context)) drafts.push(followed)
  }
  const chosen = context.chosen?.get(path)
  if (chosen) add({ path: chosen, folder: Number.NEGATIVE_INFINITY, reason: "chosen" })
  const expanded = path === "~" || path.startsWith("~/") ? join(context.home, path.slice(1)) : path
  if (isAbsolute(expanded)) {
    add({ path: normalize(expanded), folder: Number.POSITIVE_INFINITY, reason: "absolute" })
    return unique(drafts)
  }
  const parts = segmentsOf(path)
  const bare = parts.length === 1
  // A bare name from a folder only where the Thread touched it: `package.json` said while working in one.
  context.folders.forEach((folder, i) => {
    const draft = normalize(join(folder, path))
    if (!bare || context.touched.has(draft)) add({ path: draft, folder: i, reason: "from-folder" })
  })
  // `../x/y.ts` from a folder the record doesn't show: its trailing segments.
  const tail = parts.filter((part) => part !== "..")
  if (!tail.length) return unique(drafts)
  for (const file of context.touched.keys()) if (endsWithSegments(file, tail)) add({ path: file, folder: Number.POSITIVE_INFINITY, reason: "touched" })
  for (const place of context.places) {
    if (bare && !place.current) continue
    for (const inside of place.index?.find(tail.join("/"), 20) ?? []) add({ path: join(place.root, inside), folder: Number.POSITIVE_INFINITY, reason: "only-match" })
  }
  return unique(drafts)
}

/** The draft, and where it is now: renamed since, or the same file in the checkout the Thread works in now. */
function follow(draft: Draft, context: ReferenceContext): Draft[] {
  const renamed = context.renamed(draft.path)
  const own: Draft[] = renamed && renamed !== draft.path ? [draft, { path: renamed, was: draft.path, folder: draft.folder, reason: "renamed" }] : [draft]
  const out = [...own]
  for (const item of own) {
    const from = placeOf(item.path, context.places)
    if (!from || from.current || (!from.repository && !from.gone)) continue
    const inside = relative(from.root, item.path)
    for (const twin of context.places)
      if (twin !== from && twin.current && twins(from, twin)) out.push({ path: join(twin.root, inside), was: item.was ?? item.path, folder: item.folder, reason: "twin" })
  }
  return out
}

const twins = (from: Place, to: Place) =>
  from.repository !== undefined ? from.repository === to.repository : from.gone === true && from.name === to.name

function unique(drafts: Draft[]): Draft[] {
  const best = new Map<string, Draft>()
  for (const draft of drafts) {
    const seen = best.get(draft.path)
    if (!seen || draft.folder < seen.folder) best.set(draft.path, draft)
  }
  return [...best.values()]
}

function endsWithSegments(path: string, tail: readonly string[]): boolean {
  const own = segmentsOf(path)
  if (own.length < tail.length) return false
  for (let i = 1; i <= tail.length; i++) if (own[own.length - i] !== tail[tail.length - i]) return false
  return true
}

function placeOf(path: string, places: readonly Place[]): Place | undefined {
  let found: Place | undefined
  for (const place of places)
    if ((path === place.root || path.startsWith(place.root + sep)) && (!found || place.root.length > found.root.length)) found = place
  return found
}

const TOUCH_RANK = { wrote: 0, read: 1, named: 2 } as const satisfies Record<TouchKind, number>

/**
 * Which file `spelling` means, from the candidates that exist. Ranked by a
 * fixed tuple, field by field: exact from a folder the Thread was in (the
 * latest first); touched by the Thread (written, then read, then named; the
 * latest first); in a place the Thread works in now. Candidates equal on
 * all of it are a real tie, which the person settles, shortest path first;
 * what they pick stands above all of it, with the rest kept to pick again.
 * A bare name with none of the Thread's touches behind it links only as the
 * one file of that name where the Thread works now.
 */
export function resolveSpelling(spelling: string, context: ReferenceContext, exists: (path: string) => boolean): FileResolution {
  const drafts = candidatesOf(spelling, context).filter((draft) => exists(draft.path))
  if (!drafts.length) return { kind: "none" }
  const bare = segmentsOf(spellingPath(spelling)).length === 1
  const scored = drafts.map((draft) => {
    const touch = context.touched.get(draft.path) ?? (draft.was ? context.touched.get(draft.was) : undefined)
    const place = placeOf(draft.path, context.places)
    const key = [
      draft.folder,
      touch ? TOUCH_RANK[touch.kind] : 3,
      touch ? -touch.at : 0,
      place?.current ? 0 : 1,
    ]
    const candidate: FileCandidate = {
      path: draft.path,
      ...(draft.was && { was: draft.was }),
      ...(place && { place: { name: place.name, folder: relative(place.root, draft.path).split(sep).slice(0, -1).join("/") } }),
      ...(touch && { touch }),
      reason: touch && (draft.reason === "only-match" || draft.reason === "absolute") ? "touched" : draft.reason,
    }
    return { candidate, key, length: draft.path.length }
  })
  scored.sort((a, b) => compareKeys(a.key, b.key) || a.length - b.length || a.candidate.path.localeCompare(b.candidate.path))
  const first = scored[0]!
  if (first.key[0] === Number.NEGATIVE_INFINITY) {
    const rest = scored.slice(1).filter((item) => item.key[0] !== Number.NEGATIVE_INFINITY)
    const others = rest.filter((item) => rest[0] && compareKeys(item.key, rest[0].key) === 0).slice(0, 19).map((item) => item.candidate)
    return { kind: "file", file: first.candidate, ...(others.length && { others }) }
  }
  const second = scored[1]
  // A bare name links through the Thread's own touches, or as the one file of that name where it works now.
  if (bare && first.key[1] === 3 && (scored.length > 1 || first.candidate.reason !== "only-match")) return { kind: "none" }
  if (!second || compareKeys(first.key, second.key) < 0) return { kind: "file", file: first.candidate }
  const tied = scored.filter((item) => compareKeys(item.key, first.key) === 0)
  return { kind: "choice", candidates: tied.slice(0, 20).map((item) => item.candidate) }
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  return a.length - b.length
}
