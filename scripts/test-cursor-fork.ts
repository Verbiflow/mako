import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { CursorProvider } from "@mako/sessions"
import { cursorSdkAgentDirectory, cursorSdkIndexPath, cursorSdkStateRoot, cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"
import { CURSOR_SDK_IMPORT_METADATA_KEY } from "@mako/sessions/cursor-sdk-index"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { CursorSdkClient } from "@mako/host/harnesses/cursor/sdk/client"
import { cloneCursorForkStore, cursorForkDeclined, cursorForkMetadata, cursorForkPoint, readCursorForkRun } from "@mako/host/harnesses/cursor/sdk/fork"
import { CURSOR_SDK_WIRE_VERSION, SdkOpenParamsSchema, type SdkEvent, type SdkMethod, type SdkResult } from "@mako/host/harnesses/cursor/sdk/wire"
import { z } from "zod"
import type { CursorSdkLiveClient } from "@mako/host/harnesses/cursor/sdk/driver"
import { admitted } from "./fixtures/admitted-start.ts"

/**
 * A Cursor fork at a run is a native fork: a new SDK agent whose store is a
 * clone of the source's and whose index row starts at the root the run
 * checkpointed last, resumed by the SDK. Without the model: a fixture agent's
 * runs, forked through the real SDK child, the new agent's store, root and
 * index row, the source left byte for byte, and each run Cursor kept nothing
 * of declined. `--live` adds real turns: a fork at the first of two turns
 * remembers the first codeword and not the second, and a side question on
 * the source, answered by a clone made the same way, recalls the second
 * (`CURSOR_API_KEY`).
 *
 *   npm run test:cursor-fork [-- --live]
 */

const live = process.argv.includes("--live")
const root = mkdtempSync(join(tmpdir(), "mako-live-test-cursor-fork-"))
const stores = new NativeStores(false)
const child = resolve("packages/host/dist/harnesses/cursor/sdk/child.js")
const hash = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent"
/** A WAL's contents; a reader that is first to attach makes an empty one where none was, which holds nothing. */
const walHash = (path: string) => existsSync(path) && readFileSync(path).length > 0 ? hash(path) : "empty"

/** The real child, as the driver spawns it, from the built host. */
function spawnChild(cwd: string, apiKey: string, events: (event: SdkEvent) => void = () => {}): CursorSdkClient {
  return new CursorSdkClient({
    owner: randomUUID(),
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CURSOR_API_KEY: apiKey },
    entry: child,
    execPath: process.execPath,
    onEvent: events,
  })
}

const ref = (rootBlobId: string) => ({ schemaVersion: 1 as const, rootBlobId })
/** Blobs are content-addressed: the SDK takes only a SHA-256 for a blob's id. */
const blob = (name: string) => createHash("sha256").update(name).digest("hex")
type OpenParams = z.input<typeof SdkOpenParamsSchema>
type Answers = { [M in SdkMethod]?: () => SdkResult<M> }
const CheckpointRefSchema = z.object({ blobId: z.string() })
const AgentRowSchema = z.object({ workspace_ref: z.string(), name: z.string().nullable(), latest_checkpoint_ref_json: z.string(), metadata_json: z.string() })
const SdkMetaSchema = z.object({ agentId: z.string() })

try {
  assert.ok(existsSync(child), "build the host first (npm run build:electron)")
  await fixtureFork()
  await driverDeclares()
  if (live) {
    const apiKey = process.env.CURSOR_API_KEY
    if (!apiKey) throw new Error("--live needs CURSOR_API_KEY")
    await liveFork(apiKey)
  } else console.log("cursor fork: pass --live for real turns")
} finally {
  rmSync(root, { recursive: true, force: true })
}

/** A fixture agent the SDK's own store API wrote, forked by the real child at each kind of run. */
async function fixtureFork() {
  const stateRoot = join(root, "fixture", "state")
  const cwd = join(root, "fixture", "work")
  mkdirSync(cwd, { recursive: true })
  const source = "fixture-source-0000-4000-8000-000000000001"
  const sourceStore = cursorSdkStorePath(stateRoot, source)
  const now = Date.now()
  const blobKey = "ab".repeat(32)
  const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot })
  try {
    await store.agents.create({
      agent: {
        agentId: source, cwd, status: "idle", name: "Fixture source", createdAt: now, updatedAt: now, latestCheckpoint: ref(blob("root-2")),
        sdkMetadata: { blobEncryptionKey: blobKey, initialMode: "agent", [CURSOR_SDK_IMPORT_METADATA_KEY]: { path: "/legacy/store.db", identity: "legacy", agentId: "legacy" } },
      },
    })
    for (const name of ["root-1", "message-1", "root-2", "message-2"])
      await store.checkpoints.create({ agentId: source, blobId: blob(name), data: new Uint8Array(Buffer.from(name)) })
    const run = (runId: string, turnNumber: number, status: "finished" | "cancelled" | "running", start?: string, latest?: string) =>
      store.runs.create({ run: { runId, agentId: source, turnNumber, status, createdAt: now, updatedAt: now, ...start && { startCheckpointRef: ref(start) }, ...latest && { latestCheckpointRef: ref(latest) } } })
    await run("run-first", 1, "finished", undefined, blob("root-1"))
    await run("run-second", 2, "finished", blob("root-1"), blob("root-2"))
    // Stopped before its first checkpoint: the SDK leaves its latest where it started.
    await run("run-stopped", 3, "cancelled", blob("root-2"), blob("root-2"))
    await run("run-unsaved", 4, "cancelled", blob("root-2"))
    await run("run-going", 5, "running", blob("root-2"))
    await run("run-late", 6, "finished", blob("root-2"), blob("root-3"))
  } finally {
    await store.dispose()
  }
  assert.equal(metaAgent(sourceStore), source, "the SDK's store names its agent in its meta row")
  // A turn still writing: its root sits in the WAL a live writer holds open, not in the main file.
  const writer = new DatabaseSync(sourceStore)
  writer.exec("PRAGMA wal_autocheckpoint = 0")
  writer.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(blob("root-3"), Buffer.from("root-3"))
  const mainOnly = join(root, "fixture", "main-only.db")
  copyFileSync(sourceStore, mainOnly)
  const lone = new DatabaseSync(mainOnly)
  assert.equal(lone.prepare("SELECT count(*) AS n FROM blobs WHERE id = ?").get(blob("root-3"))?.["n"], 0, "the late root is only in the WAL")
  lone.close()

  const point = (runId: string) => cursorForkPoint(readCursorForkRun(stores, stateRoot, source, runId))
  assert.deepEqual(point("run-first"), { kind: "root", rootBlobId: blob("root-1") }, "a run's latest checkpoint is the conversation right after it")
  assert.deepEqual(point("run-second"), { kind: "root", rootBlobId: blob("root-2") })
  assert.match(reason(point("run-stopped")), /checkpointed nothing/)
  assert.match(reason(point("run-unsaved")), /checkpointed nothing/)
  assert.match(reason(point("run-going")), /still records this run as running/)
  assert.match(reason(cursorForkPoint(undefined)), /no record of this run/)
  const declined = (runId: string, path: string | undefined = sourceStore, own = stores) => cursorForkDeclined(own, stateRoot, { nativeId: source, runId, ...path && { path } })
  assert.equal(declined("run-first"), undefined)
  assert.equal(declined("run-late", undefined), undefined)
  assert.match(declined("run-stopped") ?? "", /checkpointed nothing/)
  assert.match(declined("run-elsewhere") ?? "", /no record of this run/)
  assert.match(declined("run-first", join(root, "elsewhere", "store.db")) ?? "", /isn't an SDK agent in this host's Cursor state root/)
  assert.match(declined("run-first", sourceStore, new NativeStores(true)) ?? "", /read-only/)
  assert.deepEqual(cursorForkMetadata({ blobEncryptionKey: blobKey, [CURSOR_SDK_IMPORT_METADATA_KEY]: {} }), { blobEncryptionKey: blobKey }, "the import record stays with the source")
  assert.throws(() => cloneCursorForkStore(new NativeStores(true), { source: sourceStore, target: join(root, "strict", "store.db"), agentId: "x", rootBlobId: blob("root-1") }), /read-only/)

  const before = { store: hash(sourceStore), wal: hash(`${sourceStore}-wal`), index: indexRows(stateRoot, source) }
  const open = async (fork: string, runId: string) => {
    const client = spawnChild(cwd, "key_fixture_0123456789abcdef")
    try {
      await client.hello()
      return await client.request("open", { cwd, stateRoot, strictStores: false, agentId: fork, create: false, name: "Fixture fork", forkFrom: { agentId: source, runId } })
    } finally {
      await client.close(5_000).catch(() => client.kill())
    }
  }

  // At the first run: the SDK resumes a new agent holding the source's blobs, at the first run's root.
  const first = randomUUID()
  assert.equal((await open(first, "run-first")).agentId, first)
  const forked = readAgent(stateRoot, first)
  assert.deepEqual(forked.latest, blob("root-1"), "the fork starts at the root the run checkpointed last")
  assert.equal(forked.cwd, cwd)
  assert.equal(forked.name, "Fixture fork")
  assert.deepEqual(forked.metadata, { blobEncryptionKey: blobKey, initialMode: "agent" }, "the fork reads its blobs with the source's key and isn't the legacy row's import")
  assert.deepEqual(forked.runs, [], "the fork has no runs until it sends one: Mako forges none")
  const forkStore = cursorSdkStorePath(stateRoot, first)
  assert.deepEqual(blobIds(forkStore), blobIds(sourceStore), "the fork's store holds the source's blobs")
  assert.equal(metaAgent(forkStore), first, "its meta row names the fork, as the SDK's own for an agent it creates")
  assert.deepEqual(readdirSync(cursorSdkAgentDirectory(stateRoot, first)).filter((name) => name.includes("forking")), [], "no staging file is left")

  // At a run whose root is still in the source's WAL, under a writer that holds it open.
  const late = randomUUID()
  await open(late, "run-late")
  assert.equal(readAgent(stateRoot, late).latest, blob("root-3"))
  assert.ok(blobIds(cursorSdkStorePath(stateRoot, late)).includes(blob("root-3")), "the clone takes what only the WAL holds")
  assert.equal(existsSync(`${cursorSdkStorePath(stateRoot, late)}-wal`) ? readFileSync(`${cursorSdkStorePath(stateRoot, late)}-wal`).length : 0, 0, "the fork's store is one file")

  // A run Cursor kept nothing of is refused before anything is written.
  const stopped = randomUUID()
  await assert.rejects(open(stopped, "run-stopped"), /checkpointed nothing/)
  assert.equal(existsSync(cursorSdkAgentDirectory(stateRoot, stopped)), false, "a refused fork leaves no store")
  assert.equal(readAgent(stateRoot, stopped).exists, false, "nor an index row")
  // The same id again is refused rather than overwritten.
  await assert.rejects(open(first, "run-second"), /already/)
  assert.equal(readAgent(stateRoot, first).latest, blob("root-1"))

  assert.notEqual(before.wal, "absent", "the source had a WAL in use while it was forked")
  assert.deepEqual({ store: hash(sourceStore), wal: hash(`${sourceStore}-wal`), index: indexRows(stateRoot, source) }, before, "the source's store, its WAL and its index rows are byte for byte as they were")
  writer.close()
  // And a source nobody has open: its one file stays as it was.
  const quiet = { store: hash(sourceStore), wal: walHash(`${sourceStore}-wal`) }
  await open(randomUUID(), "run-second")
  assert.deepEqual({ store: hash(sourceStore), wal: walHash(`${sourceStore}-wal`) }, quiet, "a quiet source's store.db is byte-identical across a fork")
  assert.deepEqual(indexRows(stateRoot, source), before.index)
  console.log("cursor fork: a fixture agent forked at a run's root through the real child, the source byte-identical, runs Cursor kept nothing of declined")
}

/** The driver declares Cursor's fork native at a run and asks the child for one. */
async function driverDeclares() {
  const { CursorSdkAuth } = await import("@mako/host/harnesses/cursor/sdk/auth")
  const { CursorCredentialStore } = await import("@mako/host/harnesses/cursor/sdk/credentials")
  const { memorySecrets } = await import("@mako/host/base/secrets")
  const { createCursorSdkDriver } = await import("@mako/host/harnesses/cursor/sdk/driver")
  const stateRoot = join(root, "driver")
  const opened: OpenParams[] = []
  const client: CursorSdkLiveClient = {
    alive: true,
    exited: new Promise(() => {}),
    hello: async () => ({ wire: CURSOR_SDK_WIRE_VERSION, sdkVersion: "fixture", node: process.version }),
    request: async (method, params) => {
      const answers: Answers = {
        me: () => ({ email: "fixture@example.test", apiKeyName: "fixture", createdAt: "2026-10-16" }),
        open: () => {
          opened.push(SdkOpenParamsSchema.parse(params))
          return { agentId: "fork-binding", model: { id: "fixture-model" } }
        },
      }
      const respond = answers[method]
      if (!respond) throw new Error(`Unexpected fixture method: ${method}`)
      return respond()
    },
    close: async () => {},
    kill() {},
  }
  const auth = new CursorSdkAuth({
    env: async () => ({ CURSOR_API_KEY: "key_fixture_0123456789abcdef" }),
    openUrl: async () => { throw new Error("Fixture must not sign in") },
    credentials: new CursorCredentialStore(memorySecrets({ durable: false })),
    cliKey: async () => null,
    client: () => client,
  })
  const driver = createCursorSdkDriver({ stores, auth, stateRoot: () => stateRoot, home: root, client: () => client, models: async () => [{ id: "fixture-model", displayName: "Fixture" }] })
  assert.equal(driver.fork.kind, "native")
  assert.equal(driver.fork.kind === "native" && driver.fork.point, "run")
  const state = await driver.start(root, admitted("cursor", {
    conversationId: "fork-binding",
    emit() {},
    fork: { nativeId: "source-agent", runId: "run-source", path: cursorSdkStorePath(stateRoot, "source-agent") },
  }, { env: { CURSOR_API_KEY: "key_fixture_0123456789abcdef" } }))
  assert.equal(state.nativeId, "fork-binding", "the fork is its own agent, under the binding's id")
  assert.deepEqual(opened.map(({ agentId, create, forkFrom }) => ({ agentId, create, forkFrom })), [{ agentId: "fork-binding", create: false, forkFrom: { agentId: "source-agent", runId: "run-source" } }])
  await driver.close("fork-binding")
  console.log("cursor fork: the driver declares a native fork at a run and opens the new agent from the source's run")
}

/** Two real turns, a fork at the first: it remembers the first codeword and not the second. */
async function liveFork(apiKey: string) {
  const userRoot = join(root, "live", "mako")
  const stateRoot = cursorSdkStateRoot(userRoot)
  const cwd = join(root, "live", "work")
  mkdirSync(cwd, { recursive: true })
  const first = `heron-${randomUUID().slice(0, 6)}`
  const second = `otter-${randomUUID().slice(0, 6)}`
  const source = randomUUID()
  const fork = randomUUID()
  const catalog = new CursorProvider(stores, root, userRoot)
  const created: string[] = []
  try {
    let sideAnswer = ""
    const turns = await session(apiKey, cwd, { cwd, stateRoot, strictStores: false, agentId: source, create: true, name: "Fork source" }, [
      `Remember this codeword: ${first}. Reply with just OK.`,
      `Remember a second codeword: ${second}. Reply with just OK.`,
    ], {
      question: "What is the second codeword I asked you to remember? Reply with just the codeword.",
      asked: (answer) => { sideAnswer = answer },
    })
    created.push(source)
    // A side question is answered by a clone of the agent, made the way a fork's store is and gone once it closes.
    assert.match(sideAnswer, new RegExp(second), `the side question's clone holds the conversation: ${sideAnswer}`)
    assert.deepEqual(readdirSync(join(stateRoot, "agents")), [basename(cursorSdkAgentDirectory(stateRoot, source))], "the side clone's folder is gone with it")
    assert.equal(metaAgent(cursorSdkStorePath(stateRoot, source)), source, "the source's meta still names it")
    const run = turns[0]!.runId
    assert.equal(cursorForkDeclined(stores, stateRoot, { nativeId: source, runId: run, path: cursorSdkStorePath(stateRoot, source) }), undefined, "Cursor checkpointed the first turn")
    const sourceBefore = hash(cursorSdkStorePath(stateRoot, source))
    const [asked] = await session(apiKey, cwd, { cwd, stateRoot, strictStores: false, agentId: fork, create: false, name: "Fork", forkFrom: { agentId: source, runId: run } }, [
      "List every codeword I asked you to remember in this conversation, comma separated, nothing else. If there are none, say NONE.",
    ])
    created.push(fork)
    assert.match(asked!.said, new RegExp(first), `the fork remembers the turn it forked at: ${asked!.said}`)
    assert.doesNotMatch(asked!.said, new RegExp(second), `and nothing after it: ${asked!.said}`)
    assert.equal(hash(cursorSdkStorePath(stateRoot, source)), sourceBefore, "the source's store is untouched by the fork")
    // The catalog reads the fork as Cursor wrote it: the first turn, then its own; never the second.
    const thread = JSON.stringify(await catalog.read(cursorSdkStorePath(stateRoot, fork)))
    assert.ok(thread.includes(first), "the fork's saved history holds the first turn")
    assert.ok(!thread.includes(second), "and not the turn after the fork point")
    const parent = JSON.stringify(await catalog.read(cursorSdkStorePath(stateRoot, source)))
    assert.ok(parent.includes(first) && parent.includes(second), "the source keeps both")
    console.log(`cursor fork: live, the fork at the first turn recalled "${asked!.said.trim()}"`)
  } finally {
    for (const agent of created) assert.equal(await catalog.remove(cursorSdkStorePath(stateRoot, agent)), true, `removed ${agent}`)
    if (created.length) {
      const index = new DatabaseSync(cursorSdkIndexPath(stateRoot), { readOnly: true })
      assert.equal(index.prepare("SELECT count(*) AS n FROM agents").get()?.["n"], 0, "the catalog's remove leaves no agent behind")
      index.close()
    }
  }
}


/** Opens an agent in a real child and sends each prompt as a turn, waiting for its result. */
async function session(apiKey: string, cwd: string, params: OpenParams, prompts: string[], side?: { question: string; asked?: (answer: string) => void }) {
  const said = new Map<string, string>()
  const ended = new Map<string, () => void>()
  const client = spawnChild(cwd, apiKey, (event) => {
    if (event.event === "message" && event.message.type === "assistant")
      said.set(event.turn, (said.get(event.turn) ?? "") + event.message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""))
    if (event.event === "result") ended.get(event.turn)?.()
  })
  try {
    await client.hello()
    const { models } = await client.request("models", undefined)
    const model = { id: (models.find((candidate) => /composer/i.test(candidate.id)) ?? models[0]!).id }
    await client.request("open", { ...params, model })
    const turns: { runId: string; said: string }[] = []
    for (const text of prompts) {
      const turn = randomUUID()
      const done = new Promise<void>((settle) => ended.set(turn, settle))
      const { runId } = await client.request("send", { turn, text, model })
      await done
      turns.push({ runId, said: said.get(turn) ?? "" })
    }
    if (side) {
      const id = randomUUID()
      const { text } = await client.request("side", { side: id, question: side.question, earlier: [] })
      side.asked?.(text)
      await client.request("sideClose", { side: id })
    }
    return turns
  } finally {
    await client.close(10_000).catch(() => client.kill())
  }
}

function reason(point: ReturnType<typeof cursorForkPoint>): string {
  return point.kind === "declined" ? point.reason : ""
}

function readAgent(stateRoot: string, agentId: string) {
  const index = new DatabaseSync(cursorSdkIndexPath(stateRoot), { readOnly: true })
  try {
    const found = index.prepare("SELECT workspace_ref, name, latest_checkpoint_ref_json, metadata_json FROM agents WHERE agent_id = ?").get(agentId)
    const runs = index.prepare("SELECT run_id FROM runs WHERE agent_id = ?").all(agentId).map((run) => run["run_id"])
    const row = found && AgentRowSchema.parse(found)
    return {
      exists: row !== undefined,
      cwd: row?.workspace_ref,
      name: row?.name,
      latest: row && CheckpointRefSchema.parse(JSON.parse(row.latest_checkpoint_ref_json)).blobId,
      metadata: row && JSON.parse(row.metadata_json),
      runs,
    }
  } finally {
    index.close()
  }
}

function indexRows(stateRoot: string, agentId: string): string {
  const index = new DatabaseSync(cursorSdkIndexPath(stateRoot), { readOnly: true })
  try {
    return JSON.stringify([
      index.prepare("SELECT * FROM agents WHERE agent_id = ?").all(agentId),
      index.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY turn_number").all(agentId),
    ])
  } finally {
    index.close()
  }
}

function blobIds(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare("SELECT id FROM blobs ORDER BY id").all().map((row) => String(row["id"]))
  } finally {
    database.close()
  }
}

function metaAgent(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const value = z.string().parse(database.prepare("SELECT value FROM meta WHERE key = '0'").get()?.["value"])
    return SdkMetaSchema.parse(JSON.parse(Buffer.from(value, "hex").toString("utf8"))).agentId
  } finally {
    database.close()
  }
}
