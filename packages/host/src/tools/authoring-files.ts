import { createHash, randomUUID } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { lock } from "proper-lockfile"

/**
 * Reading and writing one native configuration file: bounded, never through
 * a link out of the folder it belongs to, atomically, and only when the file
 * is still the revision the change was previewed against. The file as it was
 * is copied into Mako's own folder first, never beside it, so a project's
 * working tree gains nothing.
 */

/** Large enough for a busy `~/.claude.json`, which Claude Code keeps every project in; small enough to hold in memory twice. */
export const AUTHORING_LIMIT = 4 * 1024 * 1024
const BACKUPS_KEPT = 20

const missing = (error: Error & { code?: string }) => error.code === "ENOENT"
const ignoreMissing = (error: Error & { code?: string }) => { if (!missing(error)) throw error }

export function revisionOf(contents: string | null): string | null {
  return contents === null ? null : createHash("sha256").update(contents).digest("hex")
}

/** The file's text, or null when it doesn't exist; refused past the limit or when it isn't UTF-8. */
export async function boundedRead(path: string): Promise<string | null> {
  let file
  try { file = await open(path, "r") }
  catch (error) { if (error instanceof Error && missing(error)) return null; throw error }
  try {
    if ((await file.stat()).size > AUTHORING_LIMIT) throw new Error(`${path} is larger than 4 MB. Edit it in your editor.`)
    const bytes = await file.readFile()
    if (bytes.length > AUTHORING_LIMIT) throw new Error(`${path} grew past 4 MB. Edit it in your editor.`)
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally { await file.close() }
}

/** Every regular file in `folder` with one of `endings` (one level, or with `depth` below it), as paths relative to it; none when it doesn't exist. */
export async function listFiles(folder: string, endings: readonly string[], depth = 0): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string, level: number): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch((error: Error) => { ignoreMissing(error); return [] })
    for (const entry of entries) {
      const path = join(current, entry.name)
      // A link to a file is read as the harness reads it; a write through it is checked separately.
      const file = entry.isFile() || (entry.isSymbolicLink() && await stat(path).then((target) => target.isFile(), () => false))
      if (entry.isDirectory() && level < depth) await walk(path, level + 1)
      else if (file && endings.some((ending) => entry.name.endsWith(ending))) found.push(relative(folder, path))
      if (found.length > 256) throw new Error(`${folder} holds more than 256 files. Edit it in your editor.`)
    }
  }
  await walk(folder, 0)
  return found.sort()
}

/**
 * The path a write goes to: the file itself, or the file a link at it
 * points to, which must stay inside `root` (the project for a project file,
 * the harness's folder or home for a user file). A missing file's nearest
 * existing folder must be inside `root` too.
 */
export async function writablePath(root: string, path: string): Promise<string> {
  const base = await realpath(root).catch(() => root)
  const inside = (candidate: string) => {
    const suffix = relative(base, candidate)
    return !(isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${join("a", "b").slice(1, 2)}`))
  }
  const stat = await lstat(path).catch((error: Error) => { ignoreMissing(error); return null })
  if (stat?.isSymbolicLink()) {
    const target = await realpath(path)
    if (!inside(target)) throw new Error(`${path} links to ${target}, outside ${root}. Edit the file it links to in your editor.`)
    return target
  }
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    // Past the root with nothing found: the root itself is new, and the write makes it.
    const above = relative(root, ancestor)
    if (above.startsWith("..") || isAbsolute(above)) return path
    const actual = await realpath(ancestor).catch((error: Error) => { ignoreMissing(error); return null })
    if (actual !== null) {
      if (!inside(actual)) throw new Error(`${dirname(path)} leads outside ${root}. Edit it in your editor.`)
      return join(actual, relative(ancestor, path))
    }
    if (dirname(ancestor) === ancestor) return path
  }
}

/** Where a file's earlier versions are kept, by the path they came from. */
export function backupFolder(backups: string, path: string): string {
  return join(backups, createHash("sha256").update(path).digest("hex").slice(0, 16))
}

async function keepBackup(backups: string, path: string, contents: string): Promise<string> {
  const folder = backupFolder(backups, path)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await writeFile(join(folder, "path.txt"), `${path}\n`, { mode: 0o600 })
  const copy = join(folder, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}-${basename(path)}`)
  await writeFile(copy, contents, { mode: 0o600, flag: "wx" })
  const kept = (await readdir(folder)).filter((name) => name !== "path.txt").sort()
  for (const old of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) await rm(join(folder, old), { force: true })
  return copy
}

/** What one write leaves behind. */
export interface FileWrite {
  path: string
  backup: string | null
}

/**
 * Writes for one file, one at a time across every caller in this process,
 * and across Mako's profiles through a lock beside the file.
 */
export class AuthoringFiles {
  private readonly writes = new Map<string, Promise<FileWrite>>()
  private readonly backups: string

  constructor(backups: string) {
    this.backups = backups
  }

  /**
   * Replaces `path` with `next`, or deletes it when `next` is null, if it is
   * still `expected` (null: it must not exist). The previous contents are
   * copied into the backups first. The file keeps its mode, or takes `mode`
   * when one is given.
   */
  write(root: string, path: string, expected: string | null, next: string | null, mode: number | null): Promise<FileWrite> {
    const previous = this.writes.get(path) ?? Promise.resolve({ path, backup: null })
    const operation = previous.catch(() => undefined).then(() => this.writeNow(root, path, expected, next, mode))
    this.writes.set(path, operation)
    return operation.finally(() => { if (this.writes.get(path) === operation) this.writes.delete(path) })
  }

  private async writeNow(root: string, path: string, expected: string | null, next: string | null, wanted: number | null): Promise<FileWrite> {
    if (next !== null && Buffer.byteLength(next) > AUTHORING_LIMIT) throw new Error("The result would be larger than 4 MB. Edit it in your editor.")
    const target = await writablePath(root, path)
    await mkdir(dirname(target), { recursive: true })
    // SAFETY: every profile locks the same resolved path with the same lease
    // timing; a compromised lease fails the write rather than finishing it stale.
    const release = await lock(target, { realpath: false, stale: 60_000, update: 5_000, retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } })
    try {
      const current = await boundedRead(target)
      if (revisionOf(current) !== expected) throw new Error(`${path} changed after the preview. Preview the change again.`)
      const backup = current === null ? null : await keepBackup(this.backups, path, current)
      if (next === null) {
        if (revisionOf(await boundedRead(target)) !== expected) throw new Error(`${path} changed while removing. Preview the change again.`)
        // Removing an entry removes the link to it, never the file a link points to.
        await unlink(path)
        return { path, backup }
      }
      const mode = wanted ?? (current === null ? 0o644 : (await lstat(target)).mode & 0o777)
      const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, next, { mode, flag: "wx" })
        await chmod(temporary, mode)
        if (revisionOf(await boundedRead(target)) !== expected) throw new Error(`${path} changed while saving. Preview the change again.`)
        await rename(temporary, target)
      } finally { await unlink(temporary).catch(ignoreMissing) }
      return { path: target, backup }
    } finally { await release() }
  }
}

/** The newest kept copy of `path`, for undoing a write by hand. */
export async function newestBackup(backups: string, path: string): Promise<string | null> {
  const folder = backupFolder(backups, path)
  const kept = (await readdir(folder).catch((error: Error) => { ignoreMissing(error); return [] })).filter((name) => name !== "path.txt").sort()
  return kept.length ? join(folder, kept.at(-1) ?? "") : null
}

/** A kept copy's text, read back for a test or a restore. */
export function readBackup(path: string): Promise<string> {
  return readFile(path, "utf8")
}

/** Copies a backup over the file it came from, as a write of its own. */
export async function copyBack(backup: string, path: string): Promise<void> {
  await copyFile(backup, path)
}
