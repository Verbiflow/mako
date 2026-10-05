import { lstat, readFile, readlink } from "node:fs/promises"
import { join } from "node:path"
import type { ObjectReader } from "./objects.js"
import { run } from "./run.js"

/** One side of a file that isn't text: its size, and an image's bytes when they are small enough to show. */
export interface BinarySide {
  bytes: number
  image?: Buffer
}

/** What a diff view shows for one path. */
export type Preview =
  | { kind: "files"; before: string | null; after: string | null }
  /** Each side is null where the file doesn't exist; `mime` is set for an image. */
  | { kind: "binary"; mime: string | null; before: BinarySide | null; after: BinarySide | null }
  | { kind: "patch"; patch: string; limited: boolean }
  | { kind: "unavailable"; reason: string }

/** HEAD against the working tree, a commit against the working tree, a commit against its first parent, or one tree against another. */
export type Comparison = { kind: "worktree" } | { kind: "since"; oid: string } | { kind: "commit"; oid: string } | { kind: "trees"; from: string; to: string }

/** Sides read in full up to this size; larger ones are compared as a patch. */
const INLINE_BYTES = 64 * 1024
/** Past this, nothing is read for display. */
const SOURCE_BYTES = 32 * 1024 * 1024
/** An image side up to this size is sent whole to be shown; a larger one shows its size. */
const IMAGE_BYTES = 4 * 1024 * 1024
/** Image types by file extension. */
const IMAGES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
])
/** Both sides at most this many lines show as whole files. */
const FILE_LINES = 2_000
const PATCH_BYTES = 128 * 1024
const PATCH_LINES = 1_000

export const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3"] as const

type Side =
  | { kind: "missing" }
  | { kind: "bytes"; data: Buffer }
  | { kind: "large"; size: number }
  /** A submodule's commit, or a directory where a file was: Git's patch says it best. */
  | { kind: "special" }

export interface PreviewContext {
  root: string
  objects: ObjectReader
  /** `HEAD`, or the empty tree on a branch with no commits. */
  base(): Promise<string>
  /** Added to every Git process, as `objects` was given it. */
  env?: Readonly<Record<string, string | undefined>>
}

export async function readPreview(context: PreviewContext, path: string, comparison: Comparison): Promise<Preview> {
  const literal = `:(literal)${path}`
  const mime = IMAGES.get(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) ?? null
  const limit = mime ? IMAGE_BYTES : INLINE_BYTES
  const [before, after] = comparison.kind === "commit"
    ? await Promise.all([blob(context.objects, `${comparison.oid}^:${path}`, limit), blob(context.objects, `${comparison.oid}:${path}`, limit)])
    : comparison.kind === "trees"
      ? await Promise.all([blob(context.objects, `${comparison.from}:${path}`, limit), blob(context.objects, `${comparison.to}:${path}`, limit)])
      : await Promise.all([blob(context.objects, `${comparison.kind === "since" ? comparison.oid : "HEAD"}:${path}`, limit), worktree(context.root, path, limit)])
  const sides = [before, after]
  if (mime && sides.every((side) => side.kind !== "special")) return { kind: "binary", mime, before: binarySide(before, true), after: binarySide(after, true) }
  if (sides.some((side) => side.kind === "large" && side.size > SOURCE_BYTES))
    return { kind: "unavailable", reason: "The file exceeds the interactive source budget. Staging and analysis still use complete content." }
  if (sides.some((side) => side.kind === "bytes" && binary(side.data))) return { kind: "binary", mime: null, before: binarySide(before, false), after: binarySide(after, false) }
  if (sides.every((side) => side.kind === "missing" || (side.kind === "bytes" && lines(side.data) <= FILE_LINES)))
    return { kind: "files", before: text(before), after: text(after) }

  let args: string[]
  let codes: number[] = []
  if (comparison.kind === "commit") {
    args = ["diff-tree", "-p", "--no-commit-id", "--root", "-m", "--first-parent", ...DIFF_FLAGS, comparison.oid, "--", literal]
  } else if (comparison.kind === "trees") {
    args = ["diff-tree", "-p", "-r", ...DIFF_FLAGS, comparison.from, comparison.to, "--", literal]
  } else if (before.kind === "missing" && !(await context.objects.info(`:${path}`))) {
    args = ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", path]
    codes = [1]
  } else {
    args = ["diff", ...DIFF_FLAGS, comparison.kind === "since" ? comparison.oid : await context.base(), "--", literal]
  }
  const result = await run({ cwd: context.root, args, codes, env: context.env, maxBytes: PATCH_BYTES, read: true })
  const patch = result.stdout.toString("utf8")
  if (/^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch)) return { kind: "binary", mime: null, before: binarySide(before, false), after: binarySide(after, false) }
  return limitPatch(patch, result.truncated)
}

function binarySide(side: Side, image: boolean): BinarySide | null {
  switch (side.kind) {
    case "missing":
    case "special": return null
    case "large": return { bytes: side.size }
    case "bytes": return image ? { bytes: side.data.length, image: side.data } : { bytes: side.data.length }
  }
}

function limitPatch(patch: string, truncated: boolean): Preview {
  let end = -1
  for (let line = 0; line < PATCH_LINES; line += 1) {
    end = patch.indexOf("\n", end + 1)
    if (end < 0) break
  }
  if (end >= 0 && end < patch.length - 1) return { kind: "patch", patch: patch.slice(0, end + 1), limited: true }
  if (truncated) {
    const last = patch.lastIndexOf("\n")
    return { kind: "patch", patch: last >= 0 ? patch.slice(0, last + 1) : patch, limited: true }
  }
  return { kind: "patch", patch, limited: false }
}

async function blob(objects: ObjectReader, name: string, limit: number): Promise<Side> {
  const info = await objects.info(name)
  if (!info) return { kind: "missing" }
  if (info.type !== "blob") return { kind: "special" }
  if (info.size > limit) return { kind: "large", size: info.size }
  const contents = await objects.contents(name)
  return contents ? { kind: "bytes", data: contents.data } : { kind: "missing" }
}

async function worktree(root: string, path: string, limit: number): Promise<Side> {
  const absolute = join(root, path)
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink()) return { kind: "bytes", data: await readlink(absolute, { encoding: "buffer" }) }
    if (!stats.isFile()) return { kind: "special" }
    if (stats.size > limit) return { kind: "large", size: stats.size }
    return { kind: "bytes", data: await readFile(absolute) }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return { kind: "missing" }
    throw error
  }
}

const strict = new TextDecoder("utf-8", { fatal: true })

/** A NUL byte, or bytes that aren't UTF-8. */
function binary(data: Buffer): boolean {
  if (data.includes(0)) return true
  try {
    strict.decode(data)
    return false
  } catch {
    return true
  }
}

function lines(data: Buffer): number {
  let count = 0
  for (let at = data.indexOf(10); at >= 0; at = data.indexOf(10, at + 1)) count += 1
  return count
}

function text(side: Side): string | null {
  return side.kind === "bytes" ? side.data.toString("utf8") : null
}

/** The size of what a preview carries, for budgets. */
export function previewBytes(preview: Preview): number {
  switch (preview.kind) {
    case "files": return Buffer.byteLength(preview.before ?? "") + Buffer.byteLength(preview.after ?? "")
    case "patch": return Buffer.byteLength(preview.patch)
    case "binary": return (preview.before?.image?.length ?? 0) + (preview.after?.image?.length ?? 0)
    default: return 0
  }
}
