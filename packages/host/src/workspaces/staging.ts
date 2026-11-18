import { constants } from "node:fs"
import { copyFile, mkdir, open, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { StagedFile } from "../contracts/git-workspace-search.js"

/** The most base64 one staged piece carries: the window sends 512 KiB of the file at a time (`STAGED_PART_BYTES`), with room to spare. */
const STAGED_PART_CHARS = 1024 * 1024

const safeName = (name: string) => name.replace(/[/\\]/g, "_").slice(0, 120) || "attachment"

/** Where a file named `name` is staged in `dir`: its name kept legible but collision-free, and never escaping the folder. */
function stagedTarget(dir: string, name: string) {
  const safe = safeName(name)
  const stamp = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
  return { target: join(dir, `${stamp}-${safe}`), safe }
}

/**
 * Write an attachment the model cannot take inline into `dir` (the user
 * root's `attachments`, `TabServices.attachments`), and return its path. Engine-owned tools can then reach
 * it, which is the difference between "attach anything" and pretending
 * to.
 */
export async function stageBytes(dir: string, name: string, base64: string): Promise<StagedFile> {
  await mkdir(dir, { recursive: true })
  const { target, safe } = stagedTarget(dir, name)
  const bytes = Buffer.from(base64, "base64")
  await writeFile(target, bytes)
  return { path: target, name: safe, size: bytes.byteLength }
}

/**
 * One piece of a file with no path to copy from (a paste, a picture a page made), so a large one crosses in
 * messages of a bounded size instead of as one string. The first piece names the file as `stageBytes` does and
 * answers its path; each later one says that path as `into` and where its bytes go, so a piece sent twice
 * writes the same bytes to the same place. `into` is only ever a file an earlier piece made in `dir`.
 */
export async function stagePart(dir: string, name: string, base64: string, into?: { path: string; offset: number }): Promise<StagedFile> {
  if (base64.length > STAGED_PART_CHARS) throw new Error("This piece of the file is larger than one message carries.")
  if (!into) return stageBytes(dir, name, base64)
  const bytes = Buffer.from(base64, "base64")
  const target = resolve(into.path)
  if (dirname(target) !== resolve(dir) || !Number.isSafeInteger(into.offset) || into.offset < 0)
    throw new Error("That file isn't one being staged here.")
  // Opened without creating it: a piece only ever goes into the file its first piece made.
  const file = await open(target, "r+")
  try {
    await file.write(bytes, 0, bytes.byteLength, into.offset)
    return { path: target, name: safeName(name), size: (await file.stat()).size }
  } finally {
    await file.close()
  }
}

/**
 * Stage by copying from where the file already is. Drag-and-drop and the
 * file picker know the OS path, so the fast route is a filesystem copy in
 * this process — a 200MB video costs one clone, not a
 * 270MB base64 string marshalled across the IPC boundary.
 */
export async function stagePath(dir: string, sourcePath: string): Promise<StagedFile> {
  await mkdir(dir, { recursive: true })
  const { target, safe } = stagedTarget(dir, sourcePath.split("/").pop() ?? "attachment")
  // A clone where the volume makes them: no byte of the file is read or written, and its blocks are shared until
  // either copy changes. Elsewhere, and across volumes, an ordinary copy.
  await copyFile(sourcePath, target, constants.COPYFILE_FICLONE)
  const info = await stat(target)
  return { path: target, name: safe, size: info.size }
}
