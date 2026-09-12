import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderChildren } from "../electron/provider-children.ts"

const dir = await mkdtemp(join(tmpdir(), "mako-provider-children-"))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300))

try {
  // An earlier host (pid 4242) records two children and dies without cleanup.
  const earlier = new ProviderChildren(dir, 4242)
  const orphan = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  orphan.unref()
  const finished = spawn("sleep", ["0.1"], { stdio: "ignore" })
  earlier.track(orphan, { kind: "acp:test", owner: "conv-1" })
  earlier.track(finished, { kind: "acp:test", owner: "conv-2" })
  await new Promise<void>((resolve) => finished.once("exit", () => resolve()))
  await settle()
  const written = JSON.parse(await readFile(join(dir, "runtime", "provider-children.json"), "utf8"))
  assert.equal(written.children.length, 1, "a child that exited is removed from the registry")
  assert.equal(written.children[0].pid, orphan.pid)

  // A reused pid: same number, but the record says it started an hour ago.
  const reused = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  reused.unref()
  earlier.track(reused, { kind: "acp:test", owner: "conv-3" })
  const raw = JSON.parse(await readFile(join(dir, "runtime", "provider-children.json"), "utf8"))
  for (const entry of raw.children) if (entry.pid === reused.pid) entry.startedAt -= 3_600_000
  raw.children.push({ pid: 999_999_9, startedAt: Date.now(), executable: "sleep", kind: "acp:test", owner: "gone", host: 4242 })
  await rm(join(dir, "runtime", "provider-children.json"))
  const { writeFile } = await import("node:fs/promises")
  await writeFile(join(dir, "runtime", "provider-children.json"), JSON.stringify(raw))

  // The next host reaps only what still matches its record.
  const next = new ProviderChildren(dir, process.pid)
  const killed = await next.reap()
  await settle()
  assert.deepEqual(killed.map((entry) => entry.owner), ["conv-1"])
  assert.equal(alive(orphan.pid!), false, "the orphan whose identity matched was terminated")
  assert.equal(alive(reused.pid!), true, "a pid whose start time does not match the record is left alone")
  const after = JSON.parse(await readFile(join(dir, "runtime", "provider-children.json"), "utf8"))
  assert.deepEqual(after.children, [], "leftovers are cleared whether killed or already gone")

  // This host's own live children are never reaped by this host.
  const mine = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  mine.unref()
  next.track(mine, { kind: "acp:test", owner: "conv-4" })
  assert.deepEqual(await next.reap(), [])
  assert.equal(alive(mine.pid!), true)
  process.kill(reused.pid!, "SIGTERM")
  process.kill(mine.pid!, "SIGTERM")
} finally {
  await rm(dir, { recursive: true, force: true })
}
console.log("Provider children: exited children leave the registry, a later host terminates only pids whose start time and command still match, and its own children are untouched")
