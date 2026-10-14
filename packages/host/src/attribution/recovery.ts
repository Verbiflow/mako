import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { LostVersion } from "../contracts/thread-changes.js"
import { contentRef } from "./content.js"
import { within } from "./paths.js"
import { restorable, type JournalView, type Restorable } from "./queries.js"
import type { LaptopTracker } from "./tracker.js"

/*
 * Recovering lost work: versions the journal still keeps that the files on
 * disk no longer have, after `git checkout -- .`, `reset --hard`, a dropped
 * stash or another writer's overwrite, and putting one back.
 */

/** Lost versions listed at once: the newest. */
export const LOST_LISTED = 50

/** Kept versions of a Thread's files, or of one file, that differ from what is on disk now; the newest first. */
export async function lostVersions(tracker: LaptopTracker, view: JournalView, target: { thread: string } | { path: string }): Promise<LostVersion[]> {
  await tracker.settled()
  const roots = new Map(tracker.store.roots().map((root) => [root.id, root.path]))
  let versions: Restorable[]
  if ("thread" in target) versions = restorable(view, { thread: target.thread })
  else {
    const root = [...roots].find(([, path]) => within(path, target.path))
    versions = root ? restorable(view, { root: root[0], path: target.path.slice(root[1].length + 1) }) : []
  }
  const out: LostVersion[] = []
  for (const version of versions) {
    const root = roots.get(version.root)
    if (!root) continue
    if (out.length >= LOST_LISTED) break
    const path = join(root, version.path)
    const now = await readFile(path).catch(() => null)
    if (now && contentRef(now) === version.ref) continue
    const writer = "author" in version.author ? version.author.author.thread : undefined
    const by = writer ? "thread" : version.author.certainty === "person" ? "person" : version.author.certainty === "mako" ? "mako" : "unknown"
    const lost: LostVersion = { root: version.root, entry: version.entry, path, at: version.at, by }
    if (version.size !== undefined) lost.size = version.size
    if (writer) lost.thread = writer
    out.push(lost)
  }
  return out
}

/**
 * Put back the version entry `seq` wrote. What is on disk now is kept first,
 * so a restore can itself be undone the same way. The file lands by a rename,
 * never half-written, and the journal records it as the person's, through
 * Mako's editor.
 */
export async function restoreVersion(tracker: LaptopTracker, rootId: string, seq: number): Promise<{ path: string }> {
  const entry = tracker.store.entry(seq)
  const root = tracker.store.roots().find((candidate) => candidate.id === rootId)
  const bytes = entry?.after ? tracker.store.blob(entry.after) : undefined
  if (!entry || entry.root !== rootId || !root || !bytes) throw new Error("Mako no longer keeps that version.")
  const path = join(root.path, entry.path)
  const now = await readFile(path).catch(() => null)
  if (now && !tracker.store.hasBlob(contentRef(now))) tracker.store.putBlob(contentRef(now), now, Date.now())
  const mode = await stat(path).then((found) => found.mode & 0o777, () => 0o644)
  const writing = tracker.mako({ kind: "editor", operation: "restore a version", paths: [path] })
  try {
    await mkdir(dirname(path), { recursive: true })
    // Written outside the checkout, so the watcher never hears a half-written or temporary file in it.
    const pending = join(tmpdir(), `mako-restore-${randomUUID()}`)
    await writeFile(pending, bytes, { mode })
    await chmod(pending, mode)
    await rename(pending, path).catch(async (error: NodeJS.ErrnoException) => {
      await rm(pending, { force: true })
      if (error.code !== "EXDEV") throw error
      await writeFile(path, bytes, { mode })
    })
  } finally {
    writing.end()
  }
  return { path }
}
