import assert from "node:assert/strict"
import childProcess from "node:child_process"
import fs from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { ownedScratch, recoverScriptScratch } from "./lib/owned-scratch.mjs"
import { processesUsingSync, describeProcesses, removeScratch } from "./lib/scratch-processes.mjs"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-owned-scratch-test-")))
const oldEnvironment = process.env.MAKO_THREAD_SCRATCH_DIR, platform = Object.getOwnPropertyDescriptor(process, "platform")
let failure = false, malformed = false, warning = false, held = "", heldSelf = false, calls = 0
try {
  process.env.MAKO_THREAD_SCRATCH_DIR = root
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  mock.method(childProcess, "spawnSync", (command, _args, options) => {
    calls++
    assert.ok(options.timeout > 0 && options.maxBuffer > 0, "every probe has time and byte limits")
    const stdout = command === "ps" ? `${process.pid} fixture\n22222 fixture --token=not-for-output\n` : malformed ? "pwrong\0" : `p${held && !heldSelf ? 22222 : process.pid}\0n${held || "/outside"}\0\n`
    return { pid: 33333, status: failure ? null : 0, signal: null, error: failure ? new Error("unavailable") : undefined, stdout, stderr: warning ? "incomplete" : "" }
  })
  syncBuiltinESMExports()

  const disposable = ownedScratch("world-")
  writeFileSync(join(disposable.path, "payload"), "owned")
  assert.equal(existsSync(`${disposable.path}.owner.json`), true)
  assert.equal(existsSync(join(disposable.path, ".mako-owned-scratch.json")), false, "ownership receipts are not packaging inputs")
  const first = disposable.dispose(), second = disposable.dispose()
  assert.equal(first, second, "reentrant cleanup joins one retained attempt")
  await first
  assert.equal(existsSync(disposable.path), false)
  assert.equal(existsSync(`${disposable.path}.owner.json`), false)

  const existing = join(root, "existing"); mkdirSync(existing); writeFileSync(join(existing, "proof"), "keep")
  assert.throws(() => ownedScratch("world-", { root: existing }))
  assert.equal(readFileSync(join(existing, "proof"), "utf8"), "keep")

  const kept = ownedScratch("world-", { keep: true })
  await kept.dispose()
  assert.equal(existsSync(kept.path), true)
  assert.equal(existsSync(join(root, ".keep")), true, "explicit keep propagates to its managed Thread root")
  rmSync(join(root, ".keep"))

  const replaced = ownedScratch("world-")
  renameSync(replaced.path, `${replaced.path}-old`); mkdirSync(replaced.path)
  await assert.rejects(replaced.dispose(), /identity changed/)
  assert.equal(existsSync(replaced.path), true)

  const unknown = ownedScratch("world-")
  failure = true
  await assert.rejects(unknown.dispose(), /incomplete/)
  const before = calls
  await assert.rejects(unknown.dispose(), /incomplete/)
  assert.equal(calls, before, "unknown cleanup is not automatically repeated")
  assert.equal(existsSync(unknown.path), true)
  failure = false

  held = join(existing, "proof")
  assert.deepEqual(processesUsingSync(existing).map(item => item.pid), [22222])
  assert.equal(describeProcesses(processesUsingSync(existing)).includes("token"), false, "cleanup failures do not disclose command arguments")
  held = ""; malformed = true
  assert.throws(() => processesUsingSync(existing), /malformed/)
  malformed = false; warning = true
  assert.throws(() => processesUsingSync(existing), /incomplete/)
  warning = false
  const runExitCase = async (mode) => {
    const source = `import cp from 'node:child_process';import{mock}from'node:test';import{syncBuiltinESMExports}from'node:module';import{ownedScratch}from ${JSON.stringify(new URL("./lib/owned-scratch.mjs", import.meta.url).href)};Object.defineProperty(process,'platform',{value:'darwin'});mock.method(cp,'spawnSync',command=>({status:0,signal:null,stdout:command==='ps'?String(process.pid)+' fixture\\n':'p'+process.pid+'\\0n/outside\\0\\n',stderr:''}));syncBuiltinESMExports();const root=ownedScratch(${JSON.stringify(mode === "kill" ? "mako-host-load-" : "early-")});console.log(JSON.stringify({path:root.path}));${mode === "throw" ? "throw undefined" : "setInterval(()=>{},1000)"}`
    // The child has no inherited credentials and performs only fixture filesystem work and fake probes.
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { env: { MAKO_THREAD_SCRATCH_DIR: root }, stdio: ["ignore", "pipe", "pipe"] })
    let output = "", signalled = false, expired = false
    child.stdout.on("data", chunk => {
      output += chunk
      if (mode !== "throw" && output.includes("\n") && !signalled) { signalled = true; child.kill(mode === "kill" ? "SIGKILL" : "SIGTERM") }
    })
    child.stderr.resume()
    const cap = setTimeout(() => { expired = true; child.kill("SIGTERM") }, 10_000)
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })) }).finally(() => clearTimeout(cap))
    assert.equal(expired, false)
    assert.equal(result.code, mode === "kill" ? null : mode === "throw" ? 1 : 143)
    assert.equal(result.signal, mode === "kill" ? "SIGKILL" : null)
    const made = JSON.parse(output.trim()).path
    assert.ok(made.startsWith(root + "/"))
    assert.equal(existsSync(made), mode === "kill", "only SIGKILL leaves the registered world for its next-start owner")
    assert.equal(existsSync(`${made}.owner.json`), mode === "kill")
    return { path: made, pid: child.pid }
  }
  await runExitCase("throw")
  await runExitCase("signal")
  const abandoned = await runExitCase("kill"), note = `${abandoned.path}.owner.json`
  const original = readFileSync(note, "utf8"), record = JSON.parse(original)
  const preview = () => recoverScriptScratch("mako-host-load-", { parent: root }).find(row => row.path === abandoned.path)
  assert.equal(preview().eligible, true)
  assert.equal(existsSync(abandoned.path), true, "recovery preview makes no removal or lock")
  assert.equal(existsSync(`${note}.retiring`), false)
  writeFileSync(note, JSON.stringify({ ...record, pid: process.pid }))
  assert.equal(preview().eligible, false, "a live or reused PID holds the world even past expiry")
  writeFileSync(note, original)
  held = join(abandoned.path, "payload"); heldSelf = true
  assert.equal(preview().eligible, false, "the recovering caller's own open files count too")
  held = ""; heldSelf = false; failure = true
  assert.equal(preview().eligible, false, "unknown process inspection never permits recovery")
  failure = false
  writeFileSync(join(abandoned.path, ".keep"), "")
  assert.equal(preview().eligible, false); rmSync(join(abandoned.path, ".keep"))
  writeFileSync(note, JSON.stringify({ ...record, inode: "0" }))
  assert.equal(preview().eligible, false, "a replaced root cannot be adopted")
  writeFileSync(note, JSON.stringify({ ...record, version: 1 }))
  assert.equal(preview().eligible, false, "historical receipts do not gain new removal authority")
  writeFileSync(note, original)
  const kill = process.kill
  let probes = 0, reentered
  try {
    process.kill = (pid, signal) => {
      assert.equal(pid, abandoned.pid); assert.equal(signal, 0); probes++
      reentered = recoverScriptScratch("mako-host-load-", { parent: root, remove: true })
      return kill(pid, signal)
    }
    const recovered = recoverScriptScratch("mako-host-load-", { parent: root, remove: true })
    assert.equal(recovered.find(row => row.path === abandoned.path)?.removed, true)
    assert.equal(reentered.some(row => row.removed), false); assert.equal(probes, 1, "reentry observes the existing retirement lock")
  } finally { process.kill = kill }
  assert.equal(existsSync(note), false); assert.equal(existsSync(abandoned.path), false)
  const uncertain = await runExitCase("kill")
  const rename = mock.method(fs, "renameSync", () => { throw undefined }); syncBuiltinESMExports()
  const refused = recoverScriptScratch("mako-host-load-", { parent: root, remove: true })
  rename.mock.restore(); syncBuiltinESMExports()
  assert.equal(refused.find(row => row.path === uncertain.path)?.removed, false)
  const afterFailure = calls
  assert.equal(recoverScriptScratch("mako-host-load-", { parent: root, remove: true }).some(row => row.removed), false)
  assert.equal(calls, afterFailure, "unknown retirement stays held on the next call without another process probe")
  assert.equal(existsSync(`${uncertain.path}.owner.json.retiring`), true)
  const standalone = await runExitCase("kill")
  const originalTmp = process.env.TMPDIR, managed = process.env.MAKO_THREAD_SCRATCH_DIR
  let policy = { mode: "preview", idleDays: 7, kept: [] }
  const read = fs.readFileSync
  const policyRead = mock.method(fs, "readFileSync", (path, ...args) => path === join(homedir(), ".mako", "scratch-retention.json") ? JSON.stringify(policy) : read(path, ...args))
  syncBuiltinESMExports()
  try {
    delete process.env.MAKO_THREAD_SCRATCH_DIR; process.env.TMPDIR = root
    const previewRun = ownedScratch("mako-host-load-")
    assert.equal(existsSync(standalone.path), true, "a new standalone run in default preview mode does not recover old worlds")
    await previewRun.dispose()
    policy = { ...policy, mode: "remove" }
    const nextRun = ownedScratch("mako-host-load-")
    assert.equal(existsSync(standalone.path), false, "the opted-in next script start recovers its ended recorded creator")
    assert.equal(existsSync(uncertain.path), true, "the same start never reopens unknown retirement")
    await nextRun.dispose()
  } finally {
    policyRead.mock.restore(); syncBuiltinESMExports()
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp
    if (managed === undefined) delete process.env.MAKO_THREAD_SCRATCH_DIR; else process.env.MAKO_THREAD_SCRATCH_DIR = managed
  }
  assert.throws(() => recoverScriptScratch("other-", { parent: root }), /purpose/)
  console.log("Owned script scratch: exact creation, no adoption, one cleanup, explicit keep, changed identity, unknown probes, scoped presence and bounded secret-free diagnostics passed")
} finally {
  mock.restoreAll(); syncBuiltinESMExports()
  Object.defineProperty(process, "platform", platform)
  if (oldEnvironment === undefined) delete process.env.MAKO_THREAD_SCRATCH_DIR; else process.env.MAKO_THREAD_SCRATCH_DIR = oldEnvironment
  rmSync(root, { recursive: true, force: true })
}

// Linux can expose an owned-looking /proc row while denying its environment.
// Fake every process/filesystem observation here: no live /proc or UID is read.
let deniedCode = "EACCES", deniedFile = "environ", heldFile = true, heldArgs = false
let removed = 0
try {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  mock.method(process, "getuid", () => 4242)
  mock.method(fs, "statSync", path => ({ uid: path === "/proc/3000" ? 99 : 4242 }))
  mock.method(fs, "readdirSync", path => {
    if (path === "/proc") return ["1000", "2000", "3000"]
    assert.equal(path, "/proc/2000/fd")
    return ["4"]
  })
  mock.method(fs, "readFileSync", path => {
    assert.doesNotMatch(path, /3000/, "another UID is skipped before reading its files")
    if (path === "/proc/1000/cmdline" && heldArgs) return "fixture\0/fixture/scratch\0"
    if (path === `/proc/1000/${deniedFile}`) throw Object.assign(new Error("fixture denied"), { code: deniedCode })
    return path.endsWith("cmdline") ? "fixture\0" : "HOME=/outside\0"
  })
  mock.method(fs, "readlinkSync", path => path.endsWith("/fd/4") && heldFile ? "/fixture/scratch/proof" : "/outside")
  mock.method(fs, "rmSync", path => { assert.equal(path, "/fixture/scratch"); removed++ })
  syncBuiltinESMExports()
  for (const code of ["EACCES", "EPERM", "ENOENT", "ESRCH"]) {
    deniedCode = code
    assert.deepEqual(processesUsingSync("/fixture/scratch", true).map(item => item.pid), [2000], `${code} environment refusal skips that row, but keeps every readable holder`)
    if (code === "EACCES" || code === "EPERM") {
      heldArgs = true
      assert.deepEqual(processesUsingSync("/fixture/scratch", true).map(item => item.pid), [1000, 2000], `${code} cannot hide a holder already identified by its command line`)
      heldArgs = false
    }
  }
  heldFile = false
  await removeScratch("/fixture/scratch", 0)
  assert.equal(removed, 1, "an inaccessible unrelated environment cannot fail scratch cleanup")
  deniedCode = "EIO"
  assert.throws(() => processesUsingSync("/fixture/scratch", true), error => error.cause?.code === "EIO", "other environment failures remain incomplete inspection")
  deniedCode = "EACCES"; deniedFile = "cmdline"
  assert.throws(() => processesUsingSync("/fixture/scratch", true), error => error.cause?.code === "EACCES", "the exception is specific to environ, not a blanket process-probe bypass")
  assert.equal(removed, 1, "unknown probes never authorize another removal")
} finally {
  mock.restoreAll(); syncBuiltinESMExports()
  Object.defineProperty(process, "platform", platform)
}
console.log("Linux scratch: unreadable environments skipped; readable holders and other errors retained")
