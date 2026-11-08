import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Git } from "@mako/git"
import { hostGit } from "@mako/host/git/host-git"
import { hostSpawn, closeHostChild } from "@mako/host/base/host-command"
import { HostStopping, HostStoppingError } from "@mako/host/base/host-stopping"
import { HostCallLifetime } from "@mako/host/transport/call-lifetime"
import { testScratch } from "./lib/test-scratch.mjs"

const root = testScratch("mako-git-stop-")
const setup = new Git()
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
async function readyPid(file: string): Promise<number> {
  for (const deadline = Date.now() + 5_000; ; await delay(10)) {
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text) return Number(text)
    assert.ok(Date.now() < deadline, `Git's child started: ${file}`)
  }
}
async function within(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Git held the host stop or call drain")), 5_000) })]) }
  finally { clearTimeout(timer) }
}

// The reviewer's control, on both standalone Git and the host's injected runner:
// real Git, an owned pre-commit hook that ignores SIGTERM, and a joined host call.
for (const owner of ["standalone", "host", "call"] as const) {
  const cwd = join(root, owner), hooks = join(cwd, "hooks"), ready = join(cwd, "ready")
  await mkdir(cwd)
  await setup.run({ cwd, args: ["init", "-q"] })
  await mkdir(hooks)
  const hookEntry = join(hooks, "hook.cjs")
  await writeFile(hookEntry, `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
  await writeFile(join(hooks, "pre-commit"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hookEntry)}\n`, { mode: 0o700 })
  const scope = new HostStopping(), calls = new HostCallLifetime(scope)
  const cancel = new AbortController(), reason = new Error("Fixture command cancelled")
  const git = scope.run(() => owner === "host" ? hostGit(false) : new Git({ signal: owner === "standalone" ? scope.signal : undefined }))
  scope.register("Git", () => git.close())
  let pid: number | undefined
  const work = calls.run(() => git.run({ cwd, signal: owner === "call" ? cancel.signal : undefined, args: ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", `core.hooksPath=${hooks}`, "commit", "--allow-empty", "-m", "Fixture"] }))
  const ended = owner === "call" ? assert.rejects(work, (error) => error === reason) : assert.rejects(work, HostStoppingError)
  try {
    pid = await readyPid(ready)
    const drained = calls.close()
    if (owner === "call") cancel.abort(reason)
    await within(Promise.all([owner === "call" ? Promise.resolve() : scope.stop(), ended, drained]))
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }, "the real hook is gone before stop and call drain finish")
    if (owner === "call") await git.run({ cwd, args: ["status"] })
    else await assert.rejects(git.run({ cwd, args: ["status"] }), HostStoppingError)
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL") } catch { /* already reaped */ }
    await ended
    await git.close()
  }
}
console.log("real Git pre-commit hooks are reaped before calls drain, with standalone, injected and per-call cancellation")

// ObjectReader is a separate launch path. Its stand-in accepts no request and
// starts a descendant, so EOF and parent exit alone cannot prove it closed.
const cwd = join(root, "objects"), ready = join(root, "object-child"), entry = join(root, "object-reader.cjs")
await mkdir(cwd)
await setup.run({ cwd, args: ["init", "-q"] })
await writeFile(entry, `const {spawn} = require("node:child_process"); spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', process.argv[2]], {stdio: ["ignore", "inherit", "inherit"]}); process.stdin.resume(); setInterval(() => {}, 1000)`)
const scope = new HostStopping(), calls = new HostCallLifetime(scope)
// SAFETY: only the batch-command executable is substituted; every spawn overload keeps the caller's stdio and original child handle.
const launch = ((...args: Parameters<typeof hostSpawn>) => args[1]?.includes("--batch-command") ? hostSpawn(process.execPath, [entry, ready], args[2]) : hostSpawn(...args)) as typeof hostSpawn
const git = scope.run(() => new Git({ signal: scope.signal, processes: { spawn: launch, close: closeHostChild } }))
scope.register("Git", () => git.close())
const repository = await scope.run(() => git.openRepository(cwd))
assert.ok(repository)
const request = assert.rejects(calls.run(() => repository.objects.contents("HEAD:fixture")), HostStoppingError)
let pid: number | undefined
try {
  pid = await readyPid(ready)
  await within(Promise.all([scope.stop(), request, calls.close()]))
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }, "the object reader's descendant is gone at stop")
} finally {
  if (pid) try { process.kill(pid, "SIGKILL") } catch { /* already reaped */ }
  await request
  await git.close()
  await setup.close()
}
console.log("the persistent Git object reader and its descendant end through the injected runner before calls drain")
