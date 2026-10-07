import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { build } from "esbuild"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { lostCursorRun } from "../dist-electron/providers/cursor/sdk/run-records.js"
import { CURSOR_SDK_IMPORT_METADATA_KEY, cursorSdkStorePath } from "@mako/sessions"

const runRecord = (stateRoot, agentId) => join(stateRoot, "mako-runs", `${basename(dirname(cursorSdkStorePath(stateRoot, agentId)))}.json`)

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
  // What a child killed mid-run leaves: a record naming its run and itself.
  const startedAt = Date.now()
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await new Promise(resolve => gone.once("exit", resolve))
  await mkdir(dirname(runRecord(root, agentId)), { recursive: true })
  const record = (runId, pid, startedAt) => writeFile(runRecord(root, agentId), JSON.stringify({ runId, pid, startedAt }))
  const attempt = async (turn) => (await request("send", { turn, text: "Mako's child for this agent is gone." })).error.message
  await record(runId, process.pid, performance.timeOrigin)
  assert.match(await attempt("owner-alive"), /already has active run/, "a run whose recorded child still runs is never expired")
  await record("a-run-this-agent-is-not-running", gone.pid, startedAt)
  assert.match(await attempt("other-run"), /already has active run/, "a dead child's run that is no longer the active one never forces")
  await rm(runRecord(root, agentId))
  assert.match(await attempt("no-record"), /already has active run/, "without a record nothing is proved dead")
  await record(runId, gone.pid, startedAt)
  assert.match(await attempt("owner-gone"), /force takeover was attempted/, "the active run of a child that is gone is expired")
  await record(runId, process.pid, performance.timeOrigin - 3_600_000)
  assert.match(await attempt("pid-reused"), /force takeover was attempted/, "a pid now running another process is not the recorded child")
  await writeFile(runRecord(root, agentId), "{")
  assert.match(await attempt("unreadable-record"), /already has active run/, "an unreadable record proves nothing")
  await request("close")
  console.log(JSON.stringify({ scope: "production Cursor child + actual SDK SQLite, injected busy handle; not native CLI race/atomic exclusion", sdkVersion: hello.result.sdkVersion, originalRunPreserved: true, replacementRuns: 0, expiredOnlyWhenRecordedChildGoneAndRunActive: true }))
  await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("close", resolve))
  await store.dispose()
  store = undefined

  await build({ entryPoints: ["electron/providers/cursor/sdk/child.ts"], outfile: entry, platform: "node", format: "esm", bundle: true, packages: "external", plugins: [{ name: "headless-sdk-handle", setup(build) { build.onResolve({ filter: /^@cursor\/sdk$/ }, () => ({ path: join(process.cwd(), "scripts/fixtures/cursor-headless-sdk.mjs") })) } }] })
  for (const phase of ["open", "send", "send-crash", "wait", "cancel-failure", "source", "old-import", "orphan-import"]) {
    const cwd = join(root, phase)
    await mkdir(cwd)
    const spec = { stateRoot: cwd, agentId, create: false, model: { id: "composer-2" }, prompt: "must dispatch at most once" }
    let origin
    if (phase === "source" || phase === "old-import" || phase === "orphan-import") {
      const path = join(cwd, "legacy.db")
      origin = new DatabaseSync(path)
      origin.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
      origin.prepare("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId, latestRootBlobId: "original-root" }))
      spec.importFrom = { path, identity: agentId }
    }
    if (phase === "old-import") {
      const old = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: cwd })
      try {
        await old.agents.create({ agent: { agentId, cwd, status: "idle", createdAt: Date.now(), updatedAt: Date.now(), latestCheckpoint: { schemaVersion: 1, rootBlobId: "retained-sdk-history" }, sdkMetadata: { [CURSOR_SDK_IMPORT_METADATA_KEY]: { path: spec.importFrom.path, identity: agentId, agentId } } } })
      } finally { await old.dispose() }
    }
    if (phase === "orphan-import") {
      const destination = cursorSdkStorePath(cwd, agentId)
      await mkdir(join(destination, ".."), { recursive: true })
      await writeFile(destination, "retained interrupted import bytes")
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
      if (phase === "send-crash") {
        const result = await closed
        assert.equal(result.code, 77, stderr)
        const running = JSON.parse(await readFile(runRecord(cwd, agentId), "utf8"))
        assert.equal(running.pid, child.pid)
        assert.equal(await lostCursorRun(cwd, agentId), "fixture-run", "a crash inside send leaves its exact run recoverable")
        const retained = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: cwd })
        try { assert.equal((await retained.agents.get({ agentId })).activeRunId, "fixture-run") }
        finally { await retained.dispose() }
        continue
      }
      if (phase === "old-import" || phase === "orphan-import") {
        const result = await closed
        assert.equal(result.code, 1)
        assert.match(stderr, phase === "old-import" ? /predates revision receipts/ : /destination already exists/)
        assert.deepEqual(await events(), [""], "unproven imports refuse before native open or send")
        assert.equal(JSON.parse(origin.prepare("SELECT value FROM meta WHERE key = '0'").get().value).latestRootBlobId, "original-root")
        if (phase === "orphan-import") assert.equal(await readFile(cursorSdkStorePath(cwd, agentId), "utf8"), "retained interrupted import bytes")
        else {
          const retained = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: cwd })
          try { assert.equal((await retained.agents.get({ agentId })).latestCheckpoint.rootBlobId, "retained-sdk-history") }
          finally { await retained.dispose() }
        }
        continue
      }
      await until(phase === "open" || phase === "source" ? "open" : phase === "send" ? "send" : "wait")
      if (phase === "wait" || phase === "send") {
        const running = JSON.parse(await readFile(runRecord(cwd, agentId), "utf8"))
        assert.equal(running.runId, "fixture-run", "the owner is recorded even before send returns its run")
        assert.equal(running.pid, child.pid, "the record names the child executing the run")
        assert.ok(Math.abs(running.startedAt - Date.now()) < 60_000)
      }
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
        await assert.rejects(readFile(runRecord(cwd, agentId)), { code: "ENOENT" }, "a run that ended leaves nothing to expire")
        assert.equal(result.signal, phase === "cancel-failure" ? null : "SIGTERM")
        if (phase === "cancel-failure") { assert.equal(result.code, 1); assert.match(stderr, /cancellation failed/) }
      }
    } finally {
      origin?.close()
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed }
    }
  }
  console.log("Production headless child: startup/active/repeated Stop, cancellation failure, moved source, older receipts and interrupted imports preserve history without replay; injected SDK execution, not native CLI acceptance")
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve))
    child.kill("SIGKILL")
    await exited
  }
  await store?.dispose()
  await rm(root, { recursive: true, force: true })
  await rm(entry, { force: true })
}
