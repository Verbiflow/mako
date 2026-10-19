import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IntentOwner, intentStanding, processScope } from "../dist/record-intents.js"
import { lockName, LockUnavailableError, probeLock, processStart, takeLock } from "../dist/record-locks.js"
import { claimStreamWriter, streamWriterGone } from "../dist/record-streams.js"

/**
 * The record store's background locks and a stream writer's liveness, on
 * whatever platform this runs: one holder at a time across processes, freed
 * when the holder dies however it dies, two data roots never sharing a
 * lock, and a writer gone once its process is (on Linux, also when its pid
 * was given to another process). On Linux the lock is an abstract socket:
 * no file, listed by the kernel while held. `MAKO_LOCKS_WITHOUT` says what
 * the system running it lacks, as `scripts/test-linux-locks.mjs` runs it:
 * `proc` (no /proc: no start times, locks as before) or `socket` (no
 * `AF_UNIX`: no lock can be had, and that is said, never guessed around).
 */

const without = process.env.MAKO_LOCKS_WITHOUT ?? ""
const folder = await mkdtemp(join(tmpdir(), "mako-record-locks-"))
const said = []
try {
  const path = join(folder, "backfill.lock")
  if (without === "socket") {
    await assert.rejects(takeLock(path), LockUnavailableError, "with no socket, a lock is refused by name, never taken")
    assert.equal(await probeLock(path), "unknown", "and whether another holds one can't be told")
    const owner = new IntentOwner(folder)
    assert.equal(await owner.locked(), false, "an intent's owner holds no lock, and says so")
    const intent = { id: 1, owner: owner.id, scope: processScope(), pid: process.pid, start: processStart(process.pid), locked: 0, session: "s", began: Date.now(), ended: null }
    assert.notEqual((await intentStanding(folder, intent)).state, "gone", "an owner with no lock whose pid runs isn't gone")
    const exited = spawn(process.execPath, ["-e", ""])
    await once(exited, "exit")
    assert.equal((await intentStanding(folder, { ...intent, pid: exited.pid, start: null })).state, "gone", "one whose pid has exited is")
    const writer = claimStreamWriter(join(folder, "streams"))
    assert.ok(writer && !streamWriterGone(join(folder, "streams"), writer), "stream writers need no socket")
    console.log("record locks (linux, no AF_UNIX): every take refused as LockUnavailableError; owners judged by their pid")
    await rm(folder, { recursive: true, force: true })
    process.exit(0)
  }

  const held = await takeLock(path)
  assert.ok(held, "a free lock is taken")
  assert.equal(await takeLock(path), null, "a second take in the same process is refused")
  assert.equal(await probeLock(path), "held", "a probe sees it held")
  await held.release()
  assert.equal(await probeLock(path), "free", "and free once released")

  // Two data roots, two locks: the name is the root's path, so neither shuts the other out.
  const other = join(folder, "other-root", "backfill.lock")
  assert.notEqual(lockName(path), lockName(other))
  const [first, second] = [await takeLock(path), await takeLock(other)]
  assert.ok(first && second, "two data roots' locks are held at once")
  await first.release()
  await second.release()

  if (process.platform === "linux") {
    const abstract = await takeLock(path)
    assert.equal(existsSync(path), false, "on Linux the lock makes no file")
    if (without !== "proc") {
      const name = `@${lockName(path).slice(1)}`
      assert.ok(readFileSync("/proc/net/unix", "utf8").includes(name), `the kernel lists ${name} while it's held`)
      await abstract.release()
      assert.ok(!readFileSync("/proc/net/unix", "utf8").includes(name), "and not once it's released")
    } else await abstract.release()
  }

  // Another process holds it until it's killed: no clock, no stale file.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { takeLock } = await import(${JSON.stringify(new URL("../dist/record-locks.js", import.meta.url).href)})
    const lock = await takeLock(${JSON.stringify(path)})
    process.stdout.write(lock ? "held\\n" : "refused\\n")
    setInterval(() => {}, 1000)
  `], { stdio: ["ignore", "pipe", "inherit"] })
  const [answer] = await once(child.stdout, "data")
  assert.equal(String(answer).trim(), "held")
  assert.equal(await takeLock(path), null, "another process's lock is refused")
  assert.equal(await probeLock(path), "held")
  child.kill("SIGKILL")
  await once(child, "exit")
  assert.equal(await probeLock(path), "free", "a killed holder's lock is free at once")
  const after = await takeLock(path)
  assert.ok(after, "and can be taken")
  await after.release()

  // An intent's owner: running while its process holds its lock, gone once that process is killed.
  {
    const owner = new IntentOwner(folder)
    assert.equal(await owner.locked(), true)
    const intent = { id: 1, owner: owner.id, scope: owner.scope, pid: owner.pid, start: owner.start, locked: 1, session: "s", began: Date.now(), ended: null }
    assert.equal((await intentStanding(folder, intent)).state, "running", "this process's own intent runs")
    assert.equal((await intentStanding(folder, { ...intent, scope: `${owner.scope} elsewhere` })).state, "unknown", "one from another namespace can't be judged here")
    assert.equal((await intentStanding(folder, { ...intent, scope: "elsewhere", began: 0 })).state, "gone", "unless it's over a week old")
    await owner.release()
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      const { IntentOwner } = await import(${JSON.stringify(new URL("../dist/record-intents.js", import.meta.url).href)})
      const owner = new IntentOwner(${JSON.stringify(folder)})
      await owner.locked()
      process.stdout.write(JSON.stringify({ id: owner.id, scope: owner.scope, pid: owner.pid, start: owner.start }) + "\\n")
      setInterval(() => {}, 1000)
    `], { stdio: ["ignore", "pipe", "inherit"] })
    const [line] = await once(holder.stdout, "data")
    const theirs = JSON.parse(String(line))
    const row = { id: 2, owner: theirs.id, scope: theirs.scope, pid: theirs.pid, start: theirs.start, locked: 1, session: "s", began: Date.now(), ended: null }
    assert.equal((await intentStanding(folder, row)).state, "running", "another process's intent runs while it holds its lock")
    holder.kill("SIGKILL")
    await once(holder, "exit")
    const gone = await intentStanding(folder, row)
    assert.equal(gone.state, "gone", "and is gone once that process is killed")
    said.push(gone.reason)
  }

  // A stream writer: this process is alive; a pid no process has is gone.
  const streams = join(folder, "streams")
  const writer = claimStreamWriter(streams)
  assert.ok(writer)
  assert.equal(streamWriterGone(streams, writer), false, "this process's writer isn't gone")
  if (process.platform === "linux" && without !== "proc") {
    assert.equal(writer.start, processStart(process.pid), "on Linux the writer names its start")
    assert.equal(streamWriterGone(streams, { ...writer, start: writer.start - 10_000 }), true, "a pid held by a process that started at another time isn't the writer")
  }
  if (without === "proc") {
    assert.equal(processStart(process.pid), null, "with no /proc, no start time")
    assert.equal(writer.start, undefined, "and a writer names none: its pid alone answers")
    assert.equal(processScope(), (await import("node:os")).hostname(), "and the scope is the machine's name alone")
  }
  const exited = spawn(process.execPath, ["-e", ""])
  await once(exited, "exit")
  if (process.platform !== "darwin") assert.equal(streamWriterGone(streams, { id: "gone-1", pid: exited.pid }), true, "an exited process's writer is gone")
  console.log(`record locks (${process.platform}${without ? `, without ${without}` : ""}): one holder across processes, freed when it dies; two roots apart; owners running and gone ("${said[0]}"); writers alive and gone`)
} finally {
  await rm(folder, { recursive: true, force: true })
}
