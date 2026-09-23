import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
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
  await client.hello()
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
