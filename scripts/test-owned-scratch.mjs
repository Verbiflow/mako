import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { ownedScratch } from "./lib/owned-scratch.mjs"
import { processesUsingSync, describeProcesses } from "./lib/scratch-processes.mjs"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-owned-scratch-test-")))
const oldEnvironment = process.env.MAKO_THREAD_SCRATCH_DIR, platform = Object.getOwnPropertyDescriptor(process, "platform")
let failure = false, malformed = false, warning = false, held = "", calls = 0
try {
  process.env.MAKO_THREAD_SCRATCH_DIR = root
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  mock.method(childProcess, "spawnSync", (command, _args, options) => {
    calls++
    assert.ok(options.timeout > 0 && options.maxBuffer > 0, "every probe has time and byte limits")
    const stdout = command === "ps" ? `${process.pid} fixture\n22222 fixture --token=not-for-output\n` : malformed ? "pwrong\0" : `p${held ? 22222 : process.pid}\0n${held || "/outside"}\0\n`
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
    const source = `import cp from 'node:child_process';import{mock}from'node:test';import{syncBuiltinESMExports}from'node:module';import{ownedScratch}from ${JSON.stringify(new URL("./lib/owned-scratch.mjs", import.meta.url).href)};Object.defineProperty(process,'platform',{value:'darwin'});mock.method(cp,'spawnSync',command=>({status:0,signal:null,stdout:command==='ps'?String(process.pid)+' fixture\\n':'p'+process.pid+'\\0n/outside\\0\\n',stderr:''}));syncBuiltinESMExports();const root=ownedScratch('early-');console.log(JSON.stringify({path:root.path}));${mode === "throw" ? "throw undefined" : "setInterval(()=>{},1000)"}`
    // The child has no inherited credentials and performs only fixture filesystem work and fake probes.
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { env: { MAKO_THREAD_SCRATCH_DIR: root }, stdio: ["ignore", "pipe", "pipe"] })
    let output = "", signalled = false, expired = false
    child.stdout.on("data", chunk => {
      output += chunk
      if (mode === "signal" && output.includes("\n") && !signalled) { signalled = true; child.kill("SIGTERM") }
    })
    child.stderr.resume()
    const cap = setTimeout(() => { expired = true; child.kill("SIGTERM") }, 10_000)
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })) }).finally(() => clearTimeout(cap))
    assert.equal(expired, false)
    assert.equal(result.code, mode === "throw" ? 1 : 143)
    assert.equal(result.signal, null)
    const made = JSON.parse(output.trim()).path
    assert.ok(made.startsWith(root + "/"))
    assert.equal(existsSync(made), false, "the exit owner cleans a world when a caller throws or receives SIGTERM")
    assert.equal(existsSync(`${made}.owner.json`), false)
  }
  await runExitCase("throw")
  await runExitCase("signal")
  console.log("Owned script scratch: exact creation, no adoption, one cleanup, explicit keep, changed identity, unknown probes, scoped presence and bounded secret-free diagnostics passed")
} finally {
  mock.restoreAll(); syncBuiltinESMExports()
  Object.defineProperty(process, "platform", platform)
  if (oldEnvironment === undefined) delete process.env.MAKO_THREAD_SCRATCH_DIR; else process.env.MAKO_THREAD_SCRATCH_DIR = oldEnvironment
  rmSync(root, { recursive: true, force: true })
}
