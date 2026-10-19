import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import type { SessionRecords } from "./harness-records.js"

/**
 * The transcripts each session was given. A session another harness's
 * history continued in reads that history from a transcript folder (the
 * transcript and its payload files) its first turn names. Those files are
 * the session's own, as its records are: they are captured with it into the
 * record store, held whatever happens to the folder, and written back where
 * the turn names them when the session is restored. Before, 83% of the
 * bundles native sessions pointed to were gone.
 *
 * The host notes a folder once the session it opened has its native id
 * (`noteCarried`); capture adds the folder's files to the session's records
 * (`withCarried`) under a root of their own, named for where the folder's
 * parent lies, so two profiles' transcript folders never share a key.
 */
const CARRIED = "carried"
const IndexSchema = z.object({ folders: z.array(z.string()) })

/** Where the record store keeps which transcript folders a session was given. */
export function carriedIndexPath(records: string, harness: string, nativeId: string): string {
  return join(records, CARRIED, harness, `${createHash("sha256").update(nativeId).digest("hex").slice(0, 32)}.json`)
}

/** The transcript folders a session was given, in the order it was given them. */
export async function carriedFolders(records: string, harness: string, nativeId: string): Promise<string[]> {
  const text = await readFile(carriedIndexPath(records, harness, nativeId), "utf8").catch(() => null)
  return text === null ? [] : IndexSchema.catch({ folders: [] }).parse(JSON.parse(text)).folders
}

/** Notes that a session was given the transcript folder `folder`; idempotent, and written whole by a rename. */
export async function noteCarried(records: string, harness: string, nativeId: string, folder: string): Promise<void> {
  const folders = await carriedFolders(records, harness, nativeId)
  if (folders.includes(folder)) return
  const path = carriedIndexPath(records, harness, nativeId)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}`
  await writeFile(temporary, JSON.stringify({ folders: [...folders, folder] }), { mode: 0o600 })
  await rename(temporary, path)
}

/** Each noted folder that still exists, with its files: what capture takes, and what its stamp counts. */
export interface CarriedFolder {
  /** The folder's parent: the root its files are keyed under. */
  root: string
  folder: string
  files: { path: string; bytes: number; mtimeMs: number }[]
}

export async function carriedFiles(records: string, harness: string, nativeId: string): Promise<CarriedFolder[]> {
  const found: CarriedFolder[] = []
  for (const folder of await carriedFolders(records, harness, nativeId)) {
    const files = await listed(folder)
    // A folder already gone keeps what the store took of it; nothing new to take.
    if (files.length) found.push({ root: dirname(folder), folder, files })
  }
  return found
}

/** The session's records with the transcripts it was given, each folder's parent a root named for its place. */
export function withCarried(records: SessionRecords, carried: readonly CarriedFolder[]): SessionRecords {
  if (!carried.length) return records
  const roots = new Map(carried.map(({ root }) => [root, carriedRoot(root)]))
  return {
    ...records,
    roots: [...records.roots, ...[...roots].map(([path, name]) => ({ name, path }))],
    files: [...records.files, ...carried.flatMap(({ files }) => files.map(({ path }) => path))],
  }
}

/** What a session's carried files add to its stamp: each file's name, size and time, so a new or grown transcript is taken again. */
export function carriedStamp(carried: readonly CarriedFolder[]): string {
  return carried.flatMap(({ files }) => files.map(({ path, bytes, mtimeMs }) => `${path}\0${bytes}\0${mtimeMs}`)).join("\n")
}

function carriedRoot(path: string): string {
  return `mako-carried@${createHash("sha256").update(path).digest("hex").slice(0, 8)}`
}

async function listed(folder: string): Promise<CarriedFolder["files"]> {
  const out: CarriedFolder["files"] = []
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const info = await stat(path).catch(() => null)
        if (info) out.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  await walk(folder)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
