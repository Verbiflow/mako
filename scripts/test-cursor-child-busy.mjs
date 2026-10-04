import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { build } from "esbuild"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"

// Actual SDK store + production child with an injected SDK execution handle.
// This proves one-attempt busy refusal, not native CLI exclusion.
const root = await mkdtemp(join(tmpdir(), "mako-cursor-native-busy-"))
const entry = join(process.cwd(), "node_modules/.tmp/cursor-ownership-child.mjs")
const agentId = "native-busy-oracle"
const runId = "independent-executor-run"
let child
let store
try {
  await build({ entryPoints: ["electron/providers/cursor/sdk/child.ts"], outfile: entry, platform: "node", format: "esm", bundle: true, packages: "external", plugins: [{ name: "busy-sdk-handle", setup(build) { build.onResolve({ filter: /^@cursor\/sdk$/ }, () => ({ path: join(process.cwd(), "scripts/fixtures/cursor-busy-sdk.mjs") })) } }] })
  store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root })
  const now = Date.now()
  await store.agents.create({ agent: { agentId, cwd: root, status: "running", activeRunId: runId, createdAt: now, updatedAt: now } })
  await store.runs.create({ run: { agentId, runId, turnNumber: 1, status: "running", createdAt: now, updatedAt: now } })
  child = spawn(process.execPath, [entry], { cwd: root, env: { PATH: process.env.PATH, HOME: root, CURSOR_API_KEY: "invalid-disposable-test-key", NODE_OPTIONS: "" }, stdio: ["pipe", "pipe", "pipe"] })
  child.stderr.resume()
  const replies = new Map()
  const lines = createInterface({ input: child.stdout })
  lines.on("line", line => {
    const value = JSON.parse(line)
    if (value.id !== undefined) replies.get(value.id)?.(value)
  })
  let next = 0
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => { replies.delete(id); reject(new Error(`SDK child ${method} timed out`)) }, 15000)
    replies.set(id, value => { clearTimeout(timer); replies.delete(id); resolve(value) })
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  })
  const hello = await request("hello")
  assert.equal(hello.ok, true)
  const opened = await request("open", { cwd: root, stateRoot: root, agentId, create: false, model: { id: "composer-2" } })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const refused = await request("send", { turn: "must-not-take-over", text: "This attempt must not replace the existing run." })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /already has active run/)
  assert.equal((await store.agents.get({ agentId })).activeRunId, runId)
  assert.equal((await store.runs.get({ agentId, runId })).status, "running", "busy refusal must not force-expire the other executor's run")
  assert.equal((await store.runs.list({ filter: { agentIds: [agentId] } })).items.length, 1, "no replacement run was dispatched")
  await request("close")
  console.log(JSON.stringify({ scope: "production Cursor child + actual SDK SQLite, injected busy handle; not native CLI race/atomic exclusion", sdkVersion: hello.result.sdkVersion, originalRunPreserved: true, replacementRuns: 0 }))
  await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("close", resolve))
  await store.dispose()
  store = undefined

  await build({ entryPoints: ["electron/providers/cursor/sdk/child.ts"], outfile: entry, platform: "node", format: "esm", bundle: true, packages: "external", plugins: [{ name: "headless-sdk-handle", setup(build) { build.onResolve({ filter: /^@cursor\/sdk$/ }, () => ({ path: join(process.cwd(), "scripts/fixtures/cursor-headless-sdk.mjs") })) } }] })
  for (const phase of ["open", "send", "wait", "cancel-failure", "source"]) {
    const cwd = join(root, phase)
    await mkdir(cwd)
    const spec = { stateRoot: cwd, agentId, create: false, model: { id: "composer-2" }, prompt: "must dispatch at most once" }
    let origin
    if (phase === "source") {
      const path = join(cwd, "legacy.db")
      origin = new DatabaseSync(path)
      origin.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
      origin.prepare("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId, latestRootBlobId: "original-root" }))
      spec.importFrom = { path, identity: agentId }
    }
    child = spawn(process.execPath, [entry, "--headless", JSON.stringify(spec)], { cwd, env: { PATH: process.env.PATH, HOME: cwd, NODE_OPTIONS: "", MAKO_HEADLESS_FIXTURE_PHASE: phase }, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })))
    const events = async () => (await readFile(join(cwd, "trace"), "utf8").catch(() => "")).trim().split("\n")
    const until = async event => {
      const deadline = Date.now() + 5_000
      while (!(await events()).includes(event)) {
        assert.ok(child.exitCode === null && child.signalCode === null, `child exited before ${event}: ${stderr}`)
        assert.ok(Date.now() < deadline, `timed out before ${event}: ${stderr}`)
        await delay(5)
      }
    }
    try {
      await until(phase === "open" || phase === "source" ? "open" : phase === "send" ? "send" : "wait")
      if (phase === "source") {
        origin.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(JSON.stringify({ agentId, latestRootBlobId: "advanced-root" }))
        await writeFile(join(cwd, "open-go"), "release")
      } else {
        child.kill("SIGTERM")
        child.kill("SIGTERM")
        const stopDeadline = Date.now() + 5_000
        while (!stderr.includes("Stop requested")) {
          assert.ok(Date.now() < stopDeadline, "headless child did not observe Stop")
          await delay(5)
        }
        if (phase === "open") await writeFile(join(cwd, "open-go"), "release")
        else {
          if (phase === "send") await writeFile(join(cwd, "send-go"), "release")
          await until("cancel")
          assert.equal(child.exitCode, null, "cancellation must await native terminal cleanup")
          assert.equal(child.signalCode, null)
          await writeFile(join(cwd, "wait-go"), "release")
        }
      }
      const result = await closed
      const trace = await events()
      if (phase === "source") {
        assert.equal(result.code, 1)
        assert.match(stderr, /changed after import/)
        assert.equal(trace.includes("send"), false, "source movement after open refuses before any send")
      } else if (phase === "open") {
        assert.equal(result.signal, "SIGTERM", JSON.stringify({ result, trace, stderr }))
        assert.deepEqual(trace, ["open", "close"], "stop during open never sends a prompt")
      } else {
        assert.equal(trace.filter(event => event === "cancel").length, 1, "repeated Stop joins the exact run cancellation")
        assert.ok(trace.indexOf("terminal") < trace.indexOf("close"))
        assert.equal(result.signal, phase === "cancel-failure" ? null : "SIGTERM")
        if (phase === "cancel-failure") { assert.equal(result.code, 1); assert.match(stderr, /cancellation failed/) }
      }
    } finally {
      origin?.close()
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed }
    }
  }
  console.log("Production headless child: Stop during open/send/wait, repeated Stop, failed cancellation and moved import refuse without replay; injected SDK execution, not native CLI acceptance")
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve))
    child.kill("SIGKILL")
    await exited
  }
  await store?.dispose()
  await rm(root, { recursive: true, force: true })
  await rm(entry, { force: true })
}
