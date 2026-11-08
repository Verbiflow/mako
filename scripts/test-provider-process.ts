import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { ProviderChildren } from "@mako/host/base/provider-children"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChildProcess, spawn } from "node:child_process"
import {
  closeProviderProcess,
  endProviderProcess,
  MissingWorkingDirectoryError,
  ProviderProcessOutlivedError,
  providerProcessGone,
  spawnProviderProcess,
} from "@mako/host/harnesses/provider-process"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { CursorSdkClient } from "@mako/host/harnesses/cursor/sdk/client"

// A provider started in a folder that is gone names the folder, for every
// harness, instead of Node's ENOENT against an executable that exists.
const root = mkdtempSync(join(tmpdir(), "mako-provider-process-"))
const gone = join(root, "deleted-worktree")
try {
  assert.throws(
    () => spawnProviderProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: gone }),
    { name: MissingWorkingDirectoryError.name, cwd: gone, message: `The folder ${gone} no longer exists. Open this in a folder that exists.` },
    "a missing folder is refused before anything is spawned"
  )
  const child = spawnProviderProcess(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: root })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  await new Promise((resolve) => child.once("close", resolve))
  assert.equal(output, realpathSync(root), "an existing folder starts as asked")

  // A provider that exits leaving its own child on its pipes: Mako ends the
  // child with the group and closes the pipes, from one exit listener.
  const providers = new ProviderChildren(root)
  const stopFollowing = providers.follow()
  const parent = spawnProviderProcess("/bin/sh", ["-c", "sleep 30 & echo $!"], { cwd: root }, { kind: "test:provider", owner: "exit-cleanup" })
  assert.equal(parent.listenerCount("exit"), 1, "Mako's exit cleanup is one listener, leaving an SDK room for its own")
  assert.deepEqual(JSON.parse(readFileSync(providers.path, "utf8")).children.map((entry: { pid: number }) => entry.pid), [parent.pid], "the process is recorded for reaping while it runs")
  let printed = ""
  parent.stdout.on("data", (chunk: Buffer) => { printed += chunk.toString() })
  const closed = new Promise((resolve) => parent.once("close", resolve))
  await new Promise((resolve) => parent.once("exit", resolve))
  assert.deepEqual(JSON.parse(readFileSync(providers.path, "utf8")).children.map((entry: { pid: number }) => entry.pid), [parent.pid], "the parent's exit does not release its still-running descendant")
  const orphan = Number(printed.trim())
  assert.ok(orphan > 0)
  await closed
  await closeProviderProcess(parent)
  assert.deepEqual(JSON.parse(readFileSync(providers.path, "utf8")).children, [], "the reaped provider group leaves the registry")
  stopFollowing()
  const deadline = Date.now() + 5_000
  for (;;) {
    try { process.kill(orphan, 0) } catch { break }
    assert.ok(Date.now() < deadline, "the provider's own child ends with its process group")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  // Ending a provider: one that leaves when its input closes is only asked; one that ignores its input and SIGTERM
  // is killed, so whoever ends it never waits on it forever. The grace is the escalation's, not a deadline.
  const willing = spawnProviderProcess(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], { cwd: root })
  assert.equal(await endProviderProcess(willing, "input", 60_000), "exited")
  assert.deepEqual([willing.exitCode, willing.signalCode], [0, null], "a provider that leaves when its input closes is never signalled")
  const stubborn = spawnProviderProcess(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write('ready')"], { cwd: root })
  await new Promise((resolve) => stubborn.stdout.once("data", resolve))
  const ending = endProviderProcess(stubborn, "input", 200)
  assert.equal(endProviderProcess(stubborn), ending, "a second end joins the first")
  assert.equal(await ending, "exited")
  assert.equal(stubborn.signalCode, "SIGKILL", "a provider that ignores its input and SIGTERM is killed")
  assert.ok(providerProcessGone(stubborn))
  const never = spawn(join(root, "no-such-executable"), [])
  never.once("error", () => {})
  await endProviderProcess(never)
  assert.ok(providerProcessGone(never), "a process that never started counts as gone, and ending it settles")

  // A process no signal reaches is not a process that ended: giving up reads differently from gone, a close rejects,
  // and what's kept can end it later.
  const stays = spawnProviderProcess(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000); process.stdin.on('end', () => {}); process.stdout.write('ready')"], { cwd: root })
  await new Promise((resolve) => stays.stdout.once("data", resolve))
  const signal = ChildProcess.prototype.kill
  ChildProcess.prototype.kill = () => false
  try {
    assert.equal(await endProviderProcess(stays, "input", 20), "outlived", "a bounded wait that gave up doesn't read as an exit")
    assert.equal(providerProcessGone(stays), false)
    await assert.rejects(closeProviderProcess(stays, "SIGTERM", 20), { name: ProviderProcessOutlivedError.name, pid: stays.pid }, "a close that gave up rejects, naming the process")
  } finally {
    ChildProcess.prototype.kill = signal
  }
  await closeProviderProcess(stays, "SIGTERM", 20)
  assert.equal(stays.signalCode, "SIGTERM", "after giving up, the next end signals again rather than repeating the last answer")

  // The Cursor child acknowledges `close` and then stays: its client can't call that closed.
  const closeEntry = join(root, "cursor-child.cjs")
  writeFileSync(closeEntry, `
    process.stdin.on("end", () => {})
    setInterval(() => {}, 1000)
    let buffer = ""
    process.stdin.on("data", (chunk) => {
      buffer += chunk
      for (let at; (at = buffer.indexOf("\\n")) >= 0; buffer = buffer.slice(at + 1))
        process.stdout.write(JSON.stringify({ id: JSON.parse(buffer.slice(0, at)).id, ok: true, result: {} }) + "\\n")
    })
  `)
  const client = new CursorSdkClient({ owner: "outlived-close", cwd: root, env: {}, onEvent() {}, execPath: process.execPath, entry: closeEntry })
  ChildProcess.prototype.kill = () => false
  try {
    await assert.rejects(client.close(20), ProviderProcessOutlivedError, "Cursor's close doesn't succeed over a live child")
    assert.equal(client.alive, true)
  } finally {
    ChildProcess.prototype.kill = signal
  }
  await client.close(20)
  assert.equal(client.alive, false, "the next close ends it")

  await assert.rejects(
    new DiscoveryProcesses().run({ command: process.execPath, args: ["-e", ""], env: process.env, cwd: gone }, async () => "ran"),
    /no longer exists/,
    "discovery says which folder is gone, not that the CLI is missing"
  )
  assert.throws(
    () => new CursorSdkClient({ owner: "missing-folder", cwd: gone, env: {}, onEvent() {}, execPath: process.execPath }),
    MissingWorkingDirectoryError,
    "the Cursor child is refused the same way"
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("Provider process: a missing folder is named for spawned harnesses, discovery and the Cursor child; an existing one starts; ending one asks, then escalates to SIGKILL, and one that outlives that reads differently from gone")
