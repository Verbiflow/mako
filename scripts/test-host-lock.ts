import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acquireHostLock, hostLockName } from "../electron/host-lock.js"

if (process.argv[2] === "hold") await hold(process.argv[3]!)
else await check()

/** A host that holds the lock and has spawned an agent, until it's killed. */
async function hold(dataRoot: string) {
  const lock = await acquireHostLock(dataRoot)
  const agent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" })
  agent.unref()
  console.log(JSON.stringify({ lock: lock.kind, agent: agent.pid }))
  setInterval(() => {}, 1000)
}

async function check() {
  const root = await mkdtemp(join(tmpdir(), "mako-host-lock-"))
  const dataRoot = join(root, "data")
  try {
    const first = await acquireHostLock(dataRoot)
    assert.equal(first.kind, "held", "The first host takes the lock")
    const second = await acquireHostLock(dataRoot)
    assert.deepEqual(second, { kind: "taken", holder: process.pid }, "A second host is refused and told who holds it")
    assert.equal((await acquireHostLock(join(root, "other"))).kind, "held", "Another data root has its own lock")
    if (first.kind === "held") await first.release()
    const again = await acquireHostLock(dataRoot)
    assert.equal(again.kind, "held", "Releasing lets the next host in")
    if (again.kind === "held") await again.release()

    const holder = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "hold", dataRoot], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    const started = await new Promise<{ lock: string; agent: number }>((settle, reject) => {
      holder.once("exit", (code) => reject(new Error(`holder exited ${code}`)))
      holder.stdout.once("data", (chunk: Buffer) => settle(JSON.parse(chunk.toString())))
    })
    try {
      assert.equal(started.lock, "held")
      assert.deepEqual(await acquireHostLock(dataRoot), { kind: "taken", holder: holder.pid }, "Another process's lock refuses this one")
      const began = Date.now()
      assert.deepEqual(await acquireHostLock(dataRoot, { predecessor: holder.pid! + 1, waitMs: 5_000 }), { kind: "taken", holder: holder.pid },
        "A holder that isn't this host's predecessor refuses it at once")
      assert.ok(Date.now() - began < 1_000)
      assert.equal((await acquireHostLock(dataRoot, { predecessor: holder.pid, waitMs: 200 })).kind, "taken",
        "A predecessor that never leaves is given up on")
      const succeeding = acquireHostLock(dataRoot, { predecessor: holder.pid, waitMs: 10_000 })
      await new Promise((done) => setTimeout(done, 300))
      const killedAt = Date.now()
      holder.kill("SIGKILL")
      await new Promise((done) => holder.once("exit", done))
      const after = await succeeding
      assert.equal(after.kind, "held", "A successor waits for its predecessor, and a killed host's lock is free at once, though an agent it spawned still runs")
      assert.ok(Date.now() - killedAt < 1_000, "The successor takes the lock promptly")
      if (after.kind === "held") await after.release()
    } finally {
      holder.kill("SIGKILL")
      try { process.kill(started.agent, "SIGKILL") } catch { /* already gone */ }
    }

    assert.equal(hostLockName("/data", "darwin"), "/data/host.lock")
    assert.match(hostLockName("/data", "linux"), /^\0mako-host-[0-9a-f]{32}$/)
    assert.match(hostLockName("/data", "win32"), /^\\\\\.\\pipe\\mako-host-[0-9a-f]{32}$/)
    assert.equal(hostLockName("/data/../data", "linux"), hostLockName("/data", "linux"), "One data root, one name")
    console.log(`Host lock (${process.platform}): one holder per data root, the holder named, free on release and on a kill, not inherited by agents`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
