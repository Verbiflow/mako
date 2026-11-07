import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { closeSync, constants, ftruncateSync, openSync, writeFileSync, writeSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acquireHostLock, hostLockName } from "@mako/host/base/host-lock"
import { ranOut } from "./lib/ran-out.ts"

if (process.argv[2] === "hold") await hold(process.argv[3]!)
else if (process.argv[2] === "late") late(process.argv[3]!)
else if (process.argv[2] === "brief") await brief(process.argv[3]!)
else await check()

/** A `mako-host` command of an older build, or a `join` ending: it holds the lock for a moment and lets go. */
async function brief(dataRoot: string) {
  const lock = await acquireHostLock(dataRoot)
  console.log(JSON.stringify({ lock: lock.kind }))
  await new Promise((done) => setTimeout(done, 600))
  if (lock.kind === "held") await lock.release()
}

/** A host in the moment after it takes the lock and before it writes its pid. */
function late(path: string) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | 0x20 | constants.O_NONBLOCK, 0o600)
  console.log("locked")
  setTimeout(() => {
    ftruncateSync(fd, 0)
    writeSync(fd, `${process.pid}\n`, 0)
    setTimeout(() => closeSync(fd), 2_000)
  }, 100)
}

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
      // At once, and promptly, by how often it looked (every 50 ms) rather than the runner's clock.
      const { result: refused, waits: refusing } = await ranOut(() => acquireHostLock(dataRoot, { predecessor: holder.pid! + 1, waitMs: 5_000 }))
      assert.deepEqual(refused, { kind: "taken", holder: holder.pid }, "A holder that isn't this host's predecessor refuses it at once")
      assert.deepEqual(refusing, [], "never looking again")
      assert.equal((await acquireHostLock(dataRoot, { predecessor: holder.pid, waitMs: 200 })).kind, "taken",
        "A predecessor that never leaves is given up on")
      const looked: number[] = []
      const looks = () => looked.filter((ms) => ms === 50).length
      const succeeding = ranOut(() => acquireHostLock(dataRoot, { predecessor: holder.pid, waitMs: 10_000 }), looked)
      await new Promise((done) => setTimeout(done, 300))
      holder.kill("SIGKILL")
      await new Promise((done) => holder.once("exit", done))
      const looksBeforeExit = looks()
      const { result: after } = await succeeding
      assert.equal(after.kind, "held", "A successor waits for its predecessor, and a killed host's lock is free at once, though an agent it spawned still runs")
      assert.ok(looksBeforeExit > 0 && looks() - looksBeforeExit <= 2, `The successor takes the lock promptly: at its next look after the exit, or the one after (${looks() - looksBeforeExit} looks)`)
      if (after.kind === "held") await after.release()
    } finally {
      holder.kill("SIGKILL")
      try { process.kill(started.agent, "SIGKILL") } catch { /* already gone */ }
    }

    // A short-lived holder is waited out, bounded, and a host that listens is refused at once (`brief`).
    {
      const briefRoot = join(root, "brief")
      await mkdir(briefRoot)
      const passing = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "brief", briefRoot], { stdio: ["ignore", "pipe", "inherit"] })
      try {
        const said = await new Promise<{ lock: string }>((settle, reject) => {
          passing.once("exit", (code) => reject(new Error(`brief holder exited ${code}`)))
          passing.stdout.once("data", (chunk: Buffer) => settle(JSON.parse(chunk.toString())))
        })
        assert.equal(said.lock, "held")
        assert.deepEqual(await acquireHostLock(briefRoot), { kind: "taken", holder: passing.pid }, "Without waiting, the brief holder refuses this host")
        const began = Date.now()
        const waited = await acquireHostLock(briefRoot, { brief: { ms: 3_000, listening: async () => false } })
        assert.equal(waited.kind, "held", "A holder that answers nothing on the socket and lets go within a moment is waited out, and the host starts")
        assert.ok(Date.now() - began < 2_500, `waited ${Date.now() - began} ms: the wait ends as the holder lets go, not at its bound`)
        if (waited.kind === "held") await waited.release()
      } finally {
        passing.kill("SIGKILL")
      }
      const staying = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "hold", briefRoot], { stdio: ["ignore", "pipe", "inherit"] })
      const stayed = await new Promise<{ lock: string; agent: number }>((settle, reject) => {
        staying.once("exit", (code) => reject(new Error(`holder exited ${code}`)))
        staying.stdout.once("data", (chunk: Buffer) => settle(JSON.parse(chunk.toString())))
      })
      try {
        assert.equal(stayed.lock, "held")
        let began = Date.now()
        assert.deepEqual(await acquireHostLock(briefRoot, { brief: { ms: 3_000, listening: async () => true } }), { kind: "taken", holder: staying.pid },
          "A holder that answers on the host's socket is a host: refused at once, however long the wait allows")
        assert.ok(Date.now() - began < 1_000, "and without waiting")
        began = Date.now()
        assert.deepEqual(await acquireHostLock(briefRoot, { brief: { ms: 400, listening: async () => false } }), { kind: "taken", holder: staying.pid },
          "A holder that neither answers nor lets go is refused once the wait is spent: two hosts never share a data root")
        const spent = Date.now() - began
        assert.ok(spent >= 350 && spent < 2_000, `the wait is bounded by what was asked (${spent} ms)`)
      } finally {
        staying.kill("SIGKILL")
        try { process.kill(stayed.agent, "SIGKILL") } catch { /* already gone */ }
      }
    }

    if (process.platform === "darwin") {
      const lateRoot = join(root, "late")
      await mkdir(lateRoot)
      const gone = spawnSync(process.execPath, ["-e", ""]).pid
      writeFileSync(hostLockName(lateRoot), `${gone}\n`)
      const late = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "late", hostLockName(lateRoot)], { stdio: ["ignore", "pipe", "inherit"] })
      try {
        await new Promise((settle) => late.stdout.once("data", settle))
        assert.deepEqual(await acquireHostLock(lateRoot), { kind: "taken", holder: late.pid },
          "A host refused before the holder wrote its pid waits for it, rather than naming nobody or the last holder")
      } finally {
        late.kill("SIGKILL")
      }
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
