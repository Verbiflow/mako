import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { CursorSdkClient } from "../electron/providers/cursor/sdk/client.ts"

// Exercise the shipped child and real SDK SQLite store. The model catalog is
// local, credentials are fake, and the backend is deliberately unreachable.
// Native acceptance/expiration is local; no model response is needed here.
const root = await mkdtemp(join(tmpdir(), "mako-cursor-stale-run-"))
const store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root })
const agentId = randomUUID()
const runId = `run-${randomUUID()}`
const timestamp = Date.now()
await store.agents.create({ agent: {
  agentId, cwd: root, status: "running", activeRunId: runId,
  createdAt: timestamp, updatedAt: timestamp,
} })
await store.runs.create({ run: {
  agentId, runId, turnNumber: 1, status: "running",
  createdAt: timestamp, updatedAt: timestamp,
} })
const client = new CursorSdkClient({
  owner: `stale-run-fixture-${agentId}`,
  cwd: root,
  entry: resolve("dist-electron/providers/cursor/sdk/child.js"),
  execPath: process.execPath,
  env: {
    PATH: process.env.PATH,
    CURSOR_API_KEY: "key_fixture_not_a_real_credential",
    CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: JSON.stringify([{ id: "fixture-model" }]),
    CURSOR_BACKEND_URL: "http://127.0.0.1:1",
    CURSOR_API_URL: "http://127.0.0.1:1",
    CURSOR_DATA_DIR: join(root, "config"),
  },
  onEvent() {},
})
try {
  assert.equal((await client.hello()).ripgrep, true, "the child names its bundled ripgrep for Grep and Glob")
  await client.request("open", {
    agentId, cwd: root, stateRoot: root, create: false,
    model: { id: "fixture-model" },
  })
  await assert.rejects(client.request("send", {
    turn: "invalid-model", text: "Must not recover on an unrelated error",
    model: { id: "missing-model" },
  }), /Cannot use this model/)
  assert.equal((await store.runs.get({ agentId, runId }))?.status, "running")
  assert.equal((await store.runs.list({ filter: { agentIds: [agentId] } })).items.length, 1)
  const results = await Promise.allSettled([
    client.request("send", { turn: "resume", text: "Fixture resume", images: [] }),
    client.request("send", { turn: "concurrent", text: "Must be refused", images: [] }),
  ])
  const first = results[0]
  if (first.status === "rejected") throw first.reason
  assert.notEqual(first.value.runId, runId)
  assert.equal(results[1].status, "rejected", "a competing send must not expire the newly starting run")
  if (results[1].status === "rejected") assert.match(results[1].reason.message, /already running/)
  const previous = await store.runs.get({ agentId, runId })
  assert.equal(previous?.status, "expired")
  assert.equal(previous?.error, "force_send")
  const runs = await store.runs.list({ filter: { agentIds: [agentId] } })
  assert.equal(runs.items.length, 2, "one follow-up only; the original run is retained")
  assert.ok(runs.items.some((run) => run.runId === first.value.runId && run.turnNumber === 2))
  console.log("Cursor stale run: real SDK recovery, unrelated-error refusal, preserved run history, and concurrent-send refusal passed")
} finally {
  await client.close().catch(() => client.kill())
  await client.exited
  await store.dispose()
  await rm(root, { recursive: true, force: true })
}

// An uncaught failure inside the child reaches the host as one bounded log
// line before exit, naming where it was thrown and not what it said.
const secret = "fixture provider input that must stay out of logs"
const inject = `let chunks = 0; process.stdin.on("data", () => { if (++chunks === 2) setImmediate(() => { throw new TypeError(${JSON.stringify(secret)}) }) })`
const crashing = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(inject)}`,
  resolve("dist-electron/providers/cursor/sdk/child.js"),
], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } })
let output = ""
const exited = once(crashing, "exit")
const answered = new Promise<void>((settle) => crashing.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString()
  if (output.includes("\"id\":1")) settle()
}))
crashing.stdin.write(`${JSON.stringify({ id: 1, method: "hello" })}\n`)
await answered
crashing.stdin.write("\n")
const [code] = await exited
assert.equal(code, 1)
const fatal = output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.event === "log" && String(line.message).startsWith("fatal exception: TypeError"))
assert.ok(fatal, `the child reported its fatal error: ${output}`)
assert.ok(!output.includes(secret), "the crash report omits the error message")
crashing.stdin.destroy()
console.log("Cursor child crash: fatal exception reported once, without its message, before exit 1 passed")
