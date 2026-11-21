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
  // A stopping host takes its own things out of its runtime directory and nothing else: a lease a live launcher holds
  // stays for the profile's next host, and so does whatever else is in a folder the host was merely given.
  const runtime = join(root, "runtime")
  await mkdir(runtime)
  await writeFile(join(runtime, "host.sock"), "")
  const releaseLauncher = await holdHostLease(runtime)
  await writeFile(join(runtime, "leases", "lease-999999999"), "999999999")
  removeRuntimeDirectory(runtime, { files: [join(runtime, "host.sock")], own: true })
  assert.deepEqual(await readdir(runtime), ["leases"], "only the leases stay")
  assert.deepEqual(await readdir(join(runtime, "leases")), [`lease-${process.pid}`], "and of those, a gone launcher's is taken")
  assert.deepEqual(await activeHostLeases(runtime), [process.pid], "the next host is held by the same launcher")
  await releaseLauncher()
  removeRuntimeDirectory(runtime, { files: [join(runtime, "host.sock")], own: true })
  assert.deepEqual(await readdir(root).then((names) => names.includes("runtime")), false, "with no live lease the directory goes")
  const bare = join(root, "bare")
  await mkdir(bare)
  removeRuntimeDirectory(bare, { own: true })
  assert.equal((await readdir(root)).includes("bare"), false, "a host no launcher held removes its directory")

  // A socket named in a folder of someone's (MAKO_WEB_SOCKET=/tmp/h.sock): the host's socket goes, and the folder and
  // everything else in it stay. It once deleted the folder whole.
  const given = join(root, "given")
  await mkdir(join(given, "theirs"), { recursive: true })
  await writeFile(join(given, "notes.txt"), "kept")
  await writeFile(join(given, "theirs", "file"), "kept")
  await writeFile(join(given, "h.sock"), "")
  removeRuntimeDirectory(given, { files: [join(given, "h.sock")] })
  assert.deepEqual((await readdir(given)).sort(), ["notes.txt", "theirs"], "only the socket is taken from a folder the host was given")
  await rm(join(given, "notes.txt"))
  await rm(join(given, "theirs"), { recursive: true })
  removeRuntimeDirectory(given)
  assert.equal((await readdir(root)).includes("given"), true, "and the folder stays even empty: it isn't the host's")
  // Its own folder with something else in it stays too, with that in it, and a folder named as a file is left.
  const shared = join(root, "shared")
  await mkdir(join(shared, "host.sock"), { recursive: true })
  await writeFile(join(shared, "host.sock", "inside"), "kept")
  removeRuntimeDirectory(shared, { files: [join(shared, "host.sock")], own: true })
  assert.deepEqual(await readdir(join(shared, "host.sock")), ["inside"], "nothing is deleted recursively")
  console.log("Host idle: continuous idle window, activity reset, single quit, pid-bound launcher leases and leases kept across a restart passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
