import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  IdleShutdown,
  activeHostLeases,
  holdHostLease,
  removeRuntimeDirectory,
} from "@mako/host/base/host-idle"

// The idle window is measured as one continuous span; any activity restarts it.
{
  let now = 0
  let busy = false
  let quits = 0
  const idle = new IdleShutdown({
    idleMs: 1_000,
    busy: () => busy,
    quit: () => {
      quits += 1
    },
    now: () => now,
  })
  assert.equal(idle.tick(), false)
  now = 900
  assert.equal(idle.tick(), false)
  assert.equal(idle.idleFor, 900)
  busy = true
  now = 1_500
  assert.equal(idle.tick(), false, "activity inside the window resets it")
  assert.equal(idle.idleFor, 0)
  busy = false
  now = 1_600
  assert.equal(idle.tick(), false)
  now = 2_599
  assert.equal(idle.tick(), false)
  now = 2_600
  assert.equal(idle.tick(), true, "a full idle window requests the quit")
  assert.equal(quits, 1)
  now = 10_000
  assert.equal(idle.tick(), false, "the quit is requested once")
  assert.equal(quits, 1)
}

// A launcher's lease keeps a host alive only while the launcher process lives.
const root = await mkdtemp(join(tmpdir(), "mako-host-idle-"))
try {
  const release = await holdHostLease(root)
  assert.deepEqual(await activeHostLeases(root), [process.pid])
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    stdio: "ignore",
  })
  assert.ok(other.pid)
  const releaseOther = await holdHostLease(root, other.pid)
  assert.deepEqual((await activeHostLeases(root)).sort(), [other.pid, process.pid].sort())
  other.kill("SIGKILL")
  await new Promise<void>((resolve) => other.once("exit", () => resolve()))
  assert.deepEqual(await activeHostLeases(root), [process.pid], "a dead holder's lease expires")
  assert.deepEqual(await readdir(join(root, "leases")), [`lease-${process.pid}`], "expired leases are removed")
  await release()
  await releaseOther()
  assert.deepEqual(await activeHostLeases(root), [])
  assert.deepEqual(await activeHostLeases(join(root, "missing")), [], "no lease directory means no holders")

  // A stopping host removes its runtime directory, but a live launcher's lease stays for the profile's next host.
  const runtime = join(root, "runtime")
  await mkdir(runtime)
  await writeFile(join(runtime, "host.sock"), "")
  const releaseLauncher = await holdHostLease(runtime)
  removeRuntimeDirectory(runtime)
  assert.deepEqual(await readdir(runtime), ["leases"], "only the leases stay")
  assert.deepEqual(await activeHostLeases(runtime), [process.pid], "the next host is held by the same launcher")
  await releaseLauncher()
  removeRuntimeDirectory(runtime)
  assert.deepEqual(await readdir(root).then((names) => names.includes("runtime")), false, "with no live lease the directory goes")
  const bare = join(root, "bare")
  await mkdir(bare)
  removeRuntimeDirectory(bare)
  assert.equal((await readdir(root)).includes("bare"), false, "a host no launcher held removes its directory")
  console.log("Host idle: continuous idle window, activity reset, single quit, pid-bound launcher leases and leases kept across a restart passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
