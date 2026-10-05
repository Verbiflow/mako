import { lstat, readFile, readlink } from "node:fs/promises"
import { join } from "node:path"
import type { ObjectReader } from "./objects.js"
import { run } from "./run.js"

/** What a diff view shows for one path. */
export type Preview =
  | { kind: "files"; before: string | null; after: string | null }
  | { kind: "binary" }
  | { kind: "patch"; patch: string; limited: boolean }
  | { kind: "unavailable"; reason: string }

/** HEAD against the working tree, or a commit against its first parent. */
export type Comparison = { kind: "worktree" } | { kind: "commit"; oid: string }

/** Sides read in full up to this size; larger ones are compared as a patch. */
const INLINE_BYTES = 64 * 1024
/** Past this, nothing is read for display. */
const SOURCE_BYTES = 32 * 1024 * 1024
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
}

export async function readPreview(context: PreviewContext, path: string, comparison: Comparison): Promise<Preview> {
  const literal = `:(literal)${path}`
  const [before, after] = comparison.kind === "worktree"
    ? await Promise.all([blob(context.objects, `HEAD:${path}`), worktree(context.root, path)])
    : await Promise.all([blob(context.objects, `${comparison.oid}^:${path}`), blob(context.objects, `${comparison.oid}:${path}`)])
  const sides = [before, after]
  if (sides.some((side) => side.kind === "large" && side.size > SOURCE_BYTES))
    return { kind: "unavailable", reason: "The file exceeds the interactive source budget. Staging and analysis still use complete content." }
  if (sides.some((side) => side.kind === "bytes" && binary(side.data))) return { kind: "binary" }
  if (sides.every((side) => side.kind === "missing" || (side.kind === "bytes" && lines(side.data) <= FILE_LINES)))
    return { kind: "files", before: text(before), after: text(after) }

  let args: string[]
  let codes: number[] = []
  if (comparison.kind === "commit") {
    args = ["diff-tree", "-p", "--no-commit-id", "--root", "-m", "--first-parent", ...DIFF_FLAGS, comparison.oid, "--", literal]
  } else if (before.kind === "missing" && !(await context.objects.info(`:${path}`))) {
    args = ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", path]
    codes = [1]
  } else {
    args = ["diff", ...DIFF_FLAGS, await context.base(), "--", literal]
  }
  const result = await run({ cwd: context.root, args, codes, maxBytes: PATCH_BYTES, read: true })
  const patch = result.stdout.toString("utf8")
  if (/^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch)) return { kind: "binary" }
  return limitPatch(patch, result.truncated)
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

async function blob(objects: ObjectReader, name: string): Promise<Side> {
  const info = await objects.info(name)
  if (!info) return { kind: "missing" }
  if (info.type !== "blob") return { kind: "special" }
  if (info.size > INLINE_BYTES) return { kind: "large", size: info.size }
  const contents = await objects.contents(name)
  return contents ? { kind: "bytes", data: contents.data } : { kind: "missing" }
}

async function worktree(root: string, path: string): Promise<Side> {
  const absolute = join(root, path)
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink()) return { kind: "bytes", data: await readlink(absolute, { encoding: "buffer" }) }
    if (!stats.isFile()) return { kind: "special" }
    if (stats.size > INLINE_BYTES) return { kind: "large", size: stats.size }
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
    default: return 0
  }
}
