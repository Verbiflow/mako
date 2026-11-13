import { randomUUID } from "node:crypto"
import { link, readFile, unlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as pause } from "node:timers/promises"
import { z } from "zod"
import { GitError } from "./errors.js"

const Owner = z.object({
  owner: z.enum(["mako-snapshots", "mako-git-index"]),
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  host: z.string().optional(),
})
type Owner = z.infer<typeof Owner>

async function readOwner(path: string): Promise<Owner | undefined> {
  try { return Owner.safeParse(JSON.parse(await readFile(path, "utf8"))).data }
  catch { return undefined }
}

function dead(owner: Owner): boolean {
  if (owner.host !== undefined && owner.host !== hostname()) return false
  try { process.kill(owner.pid, 0); return false }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH" }
}

async function release(path: string, token: string): Promise<void> {
  if ((await readOwner(path))?.token === token) await unlink(path)
}

/** Atomic linking publishes the complete owner before the protected action starts. */
async function create(path: string): Promise<(() => Promise<void>) | undefined> {
  const owner: Owner = { owner: "mako-git-index", pid: process.pid, token: randomUUID(), host: hostname() }
  const prepared = `${path}.${owner.token}.lock`
  await writeFile(prepared, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
  try {
    // The hard link publishes a complete owner atomically and fails if a lock
    // exists. A process killed before publication leaves only its private
    // preparation file, never an empty lock blocking the next writer.
    await link(prepared, path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined
    throw error
  } finally { await unlink(prepared) }
  return () => release(path, owner.token)
}

/**
 * Reclaimers of the same dead owner contend on its token before unlinking.
 * Without that guard, two reclaimers can delete the next owner's new lock.
 * An interrupted reclaimer is recovered by the same protocol, with a bounded
 * depth; malformed ownership and a reused PID are conservatively left alone.
 */
async function recover(path: string, depth = 0): Promise<boolean> {
  const previous = await readOwner(path)
  if (!previous || !dead(previous) || depth >= 8) return false
  const guard = join(dirname(path), `mako-index-recover-${previous.token}.lock`)
  let done = await create(guard)
  if (!done && await recover(guard, depth + 1)) done = await create(guard)
  if (!done) return false
  try {
    const current = await readOwner(path)
    if (current?.token !== previous.token || !dead(current)) return false
    await unlink(path)
    return true
  } finally { await done() }
}

function busy(): GitError {
  return new GitError({ message: "The workspace is busy. Finish the other Git or checkpoint operation and retry.", command: "index" })
}

/**
 * Serializes Mako's index operations across hosts and repository instances.
 * Git still takes its own index.lock: external Git commands retain their normal
 * exclusion. We never retry a mutation; waiting happens before it starts.
 */
export async function withIndexWriteLock<T>(gitDir: string, action: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  const path = join(gitDir, "mako-index-write.lock")
  let done: (() => Promise<void>) | undefined
  while (!(done = await create(path))) {
    if (await recover(path)) continue
    // Unknown ownership is never reclaimed. It may be a legacy host still
    // writing its owner record, so wait rather than failing at publication.
    if (performance.now() >= deadline) throw busy()
    await pause(25)
  }
  try {
    // Earlier hosts used only these checkpoint markers. Reclaim abandoned ones
    // before staging, and wait for live checkpoints without replaying Git writes.
    for (const marker of ["mako-snapshots.lock", "index.lock"]) {
      const lock = join(gitDir, marker)
      while (await readOwner(lock)) {
        if (await recover(lock)) continue
        if (performance.now() >= deadline) throw busy()
        await pause(25)
      }
    }
    return await action()
  } finally { await done() }
}

/** Called inside the coordinator, for operations copying the real index and writing a private one. */
export async function withReservedIndex<T>(gitDir: string, action: () => Promise<T>): Promise<T> {
  const done = await create(join(gitDir, "index.lock"))
  if (!done) throw busy()
  try { return await action() }
  finally { await done() }
}
