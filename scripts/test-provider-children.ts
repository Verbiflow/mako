import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises"
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

const owned: ChildProcess[] = []
try {
  // An earlier host (pid 4242) records two children and dies without cleanup.
  const earlier = new ProviderChildren(dir, 4242)
  const orphan = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  owned.push(orphan)
  orphan.unref()
  const nodeLink = join(dir, "node-link")
  await symlink(process.execPath, nodeLink)
  const titled = spawn(
    nodeLink,
    ["-e", "process.title = 'mako-test-child'; setInterval(() => {}, 60_000)"],
    { stdio: "ignore", detached: true }
  )
  owned.push(titled)
  titled.unref()
  const shebangPath = join(dir, "provider-cli")
  await writeFile(
    shebangPath,
    "#!/usr/bin/env node\nsetInterval(() => {}, 60_000)\n"
  )
  await chmod(shebangPath, 0o700)
  const shebang = spawn(shebangPath, [], {
    stdio: "ignore",
    detached: true,
  })
  owned.push(shebang)
  shebang.unref()
  const wrapperPath = join(dir, "provider-wrapper")
  await writeFile(wrapperPath, "#!/bin/sh\nsleep 0.05\nexec sleep 120\n")
  await chmod(wrapperPath, 0o700)
  const wrapper = spawn(wrapperPath, [], {
    stdio: "ignore",
    detached: true,
  })
  owned.push(wrapper)
  wrapper.unref()
  const finished = spawn("sleep", ["0.1"], { stdio: "ignore" })
  earlier.track(orphan, { kind: "acp:test", owner: "conv-1" })
  earlier.track(titled, { kind: "sdk:test", owner: "conv-title" })
  earlier.track(shebang, { kind: "acp:test", owner: "conv-shebang" })
  earlier.track(wrapper, { kind: "acp:test", owner: "conv-wrapper" })
  earlier.track(finished, { kind: "acp:test", owner: "conv-2" })
  await new Promise<void>((resolve) => finished.once("exit", () => resolve()))
  const deadline = Date.now() + 10_000
  const wrappedExecutable = await realpath("/bin/sleep")
  while (true) {
    const records = JSON.parse(await readFile(earlier.path, "utf8")).children
    if (
      records.length === 4 &&
      records.every(
        (entry: { executableIdentity?: string }) => entry.executableIdentity
      ) &&
      records.find((entry: { owner: string }) => entry.owner === "conv-wrapper")
        ?.executableIdentity === wrappedExecutable
    )
      break
    assert.ok(
      Date.now() < deadline,
      "Asynchronous native process identities did not arrive"
    )
    await settle()
  }
  const written = JSON.parse(
    await readFile(join(dir, "runtime", "provider-children.json"), "utf8")
  )
  assert.equal(
    written.children.length,
    4,
    "a child that exited is removed from the registry"
  )
  assert.equal(written.children[0].pid, orphan.pid)
  assert.equal(
    written.children.find(
      (entry: { owner: string }) => entry.owner === "conv-shebang"
    )?.executableIdentity,
    process.execPath,
    "tracking records the interpreter image after a shebang exec"
  )

  // A reused pid: same number, but the record says it started an hour ago.
  const reused = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  owned.push(reused)
  reused.unref()
  earlier.track(reused, { kind: "acp:test", owner: "conv-3" })
  const raw = JSON.parse(
    await readFile(join(dir, "runtime", "provider-children.json"), "utf8")
  )
  // The abandoned host must stop writing before constructing the restart
  // snapshot; otherwise its scheduled identity refresh overwrites the forged
  // recycled-PID record while the next host is inspecting it.
  for (const child of owned) if (child.pid) earlier.untrackPid(child.pid)
  for (const entry of raw.children)
    if (entry.owner === "conv-shebang") delete entry.executableIdentity
  for (const entry of raw.children)
    if (entry.pid === reused.pid) {
      entry.startedAt -= 3_600_000
      if (entry.processStartedAt) entry.processStartedAt += 1_000
    }
  raw.children.push({
    pid: 999_999_9,
    startedAt: Date.now(),
    executable: "sleep",
    kind: "acp:test",
    owner: "gone",
    host: 4242,
  })
  await rm(join(dir, "runtime", "provider-children.json"))
  await writeFile(
    join(dir, "runtime", "provider-children.json"),
    JSON.stringify(raw)
  )

  // The next host reaps only what still matches its record.
  const next = new ProviderChildren(dir, process.pid)
  const killed = await next.reap()
  await settle()
  assert.deepEqual(
    killed.map((entry) => entry.owner),
    ["conv-1", "conv-title", "conv-shebang", "conv-wrapper"]
  )
  assert.equal(
    alive(orphan.pid!),
    false,
    "the orphan whose identity matched was terminated"
  )
  assert.equal(
    alive(titled.pid!),
    false,
    "an orphan remains identifiable after overwriting its process title"
  )
  assert.equal(
    alive(shebang.pid!),
    false,
    "a shebang provider is matched by its actual interpreter image"
  )
  assert.equal(
    alive(wrapper.pid!),
    false,
    "tracking follows a shell wrapper into its final process image"
  )
  assert.equal(
    alive(reused.pid!),
    true,
    "a pid whose start time does not match the record is left alone"
  )
  const after = JSON.parse(
    await readFile(join(dir, "runtime", "provider-children.json"), "utf8")
  )
  assert.deepEqual(
    after.children,
    [],
    "leftovers are cleared whether killed or already gone"
  )

  // An executable mismatch does not prove death. Preserve it across later
  // registry writes, and let a later verified observation authorize cleanup.
  const uncertain = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  owned.push(uncertain)
  uncertain.unref()
  const uncertainRecord = {
    ...written.children[0],
    pid: uncertain.pid,
    startedAt: Date.now(),
    processStartedAt: undefined,
    executableIdentity: "/not-the-spawned-executable",
    owner: "uncertain-image",
  }
  await writeFile(next.path, JSON.stringify({ children: [uncertainRecord] }))
  assert.deepEqual(await next.reap(), [])
  assert.equal(alive(uncertain.pid!), true, "unknown executable never authorizes a signal")
  next.untrackPid(-1)
  assert.equal(JSON.parse(await readFile(next.path, "utf8")).children[0].owner, "uncertain-image")

  // This host's own live children are never reaped by this host.
  const mine = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  owned.push(mine)
  mine.unref()
  next.track(mine, { kind: "acp:test", owner: "conv-4" })
  assert.deepEqual(await next.reap(), [])
  assert.equal(alive(mine.pid!), true)
  assert.ok(
    JSON.parse(await readFile(next.path, "utf8")).children.some(
      (entry: { owner: string }) => entry.owner === "uncertain-image"
    ),
    "tracking new children retains unresolved foreign ownership"
  )
  const retry = JSON.parse(await readFile(next.path, "utf8"))
  retry.children.find((entry: { owner: string }) => entry.owner === "uncertain-image").executableIdentity = wrappedExecutable
  await writeFile(next.path, JSON.stringify(retry))
  assert.deepEqual((await next.reap()).map((entry) => entry.owner), ["uncertain-image"])
  await settle()
  assert.equal(alive(uncertain.pid!), false)

  const activeHost = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  const activeChild = spawn("sleep", ["120"], { stdio: "ignore", detached: true })
  owned.push(activeHost, activeChild)
  activeHost.unref()
  activeChild.unref()
  const liveForeign = JSON.parse(await readFile(next.path, "utf8"))
  liveForeign.children.push({
    ...uncertainRecord,
    host: activeHost.pid,
    pid: activeChild.pid,
    startedAt: Date.now(),
    executableIdentity: wrappedExecutable,
    owner: "living-foreign-host",
  })
  await writeFile(next.path, JSON.stringify(liveForeign))
  assert.deepEqual(await next.reap(), [])
  assert.equal(alive(activeChild.pid!), true, "a living foreign host owns its children")
  activeHost.ref()
  const foreignHostExited = new Promise<void>(resolve => activeHost.once("exit", () => resolve()))
  activeHost.kill("SIGTERM")
  await foreignHostExited
  assert.deepEqual((await next.reap()).map(entry => entry.owner), ["living-foreign-host"])
  await settle()
  assert.equal(alive(activeChild.pid!), false, "verified orphan is reaped after its host exits")
  process.kill(reused.pid!, "SIGTERM")
  process.kill(mine.pid!, "SIGTERM")
} finally {
  await Promise.all(
    owned.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }
          child.ref()
          child.once("exit", () => resolve())
          child.kill("SIGTERM")
        })
    )
  )
  await rm(dir, { recursive: true, force: true })
}
console.log(
  "Provider children: exited children leave the registry, a later host terminates only pids whose start time and executable still match after a title change, and its own children are untouched"
)
