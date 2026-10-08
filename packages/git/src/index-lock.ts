import { randomUUID } from "node:crypto"
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
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

function readOwner(path: string): Owner | undefined {
  try { return Owner.safeParse(JSON.parse(readFileSync(path, "utf8"))).data }
  catch { return undefined }
}

function dead(owner: Owner): boolean {
  if (owner.host !== undefined && owner.host !== hostname()) return false
  try { process.kill(owner.pid, 0); return false }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH" }
}

function release(path: string, token: string): void {
  if (readOwner(path)?.token === token) unlinkSync(path)
}

/** Exclusive creation publishes ownership before any asynchronous work starts. */
function create(path: string): (() => void) | undefined {
  const owner: Owner = { owner: "mako-git-index", pid: process.pid, token: randomUUID(), host: hostname() }
  try { writeFileSync(path, JSON.stringify(owner), { flag: "wx", mode: 0o600 }) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined
    throw error
  }
  return () => release(path, owner.token)
}

/**
 * Reclaimers of the same dead owner contend on its token before unlinking.
 * Without that guard, two reclaimers can delete the next owner's new lock.
 * An interrupted reclaimer is recovered by the same protocol, with a bounded
 * depth; malformed ownership and a reused PID are conservatively left alone.
 */
function recover(path: string, depth = 0): boolean {
  const previous = readOwner(path)
  if (!previous || !dead(previous) || depth >= 8) return false
  const guard = `${path}.recover-${previous.token}.lock`
  let done = create(guard)
  if (!done && recover(guard, depth + 1)) done = create(guard)
  if (!done) return false
  try {
    const current = readOwner(path)
    if (current?.token !== previous.token || !dead(current)) return false
    unlinkSync(path)
    return true
  } finally { done() }
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
  let done: (() => void) | undefined
  while (!(done = create(path))) {
    if (recover(path)) continue
    if (!readOwner(path) || performance.now() >= deadline) throw busy()
    await pause(25)
  }
  try {
    // Earlier hosts used only these checkpoint markers. Reclaim abandoned ones
    // before staging, and wait for live checkpoints without replaying Git writes.
    for (const marker of ["mako-snapshots.lock", "index.lock"]) {
      const lock = join(gitDir, marker)
      while (readOwner(lock)) {
        if (recover(lock)) continue
        if (performance.now() >= deadline) throw busy()
        await pause(25)
      }
    }
    return await action()
  } finally { done() }
}
