import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionCatalog } from "../dist/catalog.js"
import { threadIdentity } from "../dist/format.js"
import { CursorProvider } from "../dist/providers/cursor.js"

async function writeStore(directory, meta, prompt) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const db = new DatabaseSync(path)
  try {
    db.exec(
      "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    const hash = Buffer.alloc(32, 1)
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(
      hash.toString("hex"),
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: `<user_query>${prompt}</user_query>` }],
        })
      )
    )
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(
      "root",
      Buffer.concat([Buffer.from([10, 32]), hash])
    )
    db.prepare("INSERT INTO meta VALUES (?, ?)").run(
      "0",
      JSON.stringify({ latestRootBlobId: "root", ...meta })
    )
  } finally {
    db.close()
  }
  return path
}

// `cursor-agent -p --resume <id>` on an ACP session writes its new turns to
// a second store under chats/ with the same agent id. Before this the catalog
// collapsed the two by native id and the newer, one-turn fork replaced the
// whole original in the rail.
const home = await mkdtemp(join(tmpdir(), "mako-cursor-fork-"))
try {
  const id = "33333333-3333-4333-8333-333333333333"
  const original = await writeStore(
    join(home, ".cursor", "acp-sessions", id),
    { agentId: id, name: "Mako Relay Investigation" },
    "investigate the relay"
  )
  await writeFile(
    join(home, ".cursor", "acp-sessions", id, "meta.json"),
    JSON.stringify({ cwd: home, title: "Mako Relay Investigation", updatedAtMs: 1_000 })
  )
  const fork = await writeStore(
    join(home, ".cursor", "chats", "workspace", id),
    { agentId: id, name: "New Agent", isRunEverything: true },
    "Q1. Who is the user"
  )
  await writeFile(
    join(home, ".cursor", "chats", "workspace", id, "meta.json"),
    JSON.stringify({ cwd: home, hasConversation: true, updatedAtMs: 2_000 })
  )
  const provider = new CursorProvider(home, {})
  const files = await provider.discover()
  const originalRef = await provider.peek(files.find((file) => file.path === original))
  const forkRef = await provider.peek(files.find((file) => file.path === fork))
  assert.equal(originalRef.nativeId, id)
  assert.equal(forkRef.nativeId, id, "both stores keep the agent id their CLI resumes by")
  assert.equal(originalRef.identity, undefined)
  assert.equal(originalRef.liveResume, undefined, "an acp-sessions store continues through the SDK")
  assert.equal(forkRef.identity, `chats:${id}`)
  assert.equal(forkRef.liveResume, undefined, "so does a chats store: the SDK imports either")
  assert.notEqual(threadIdentity(originalRef), threadIdentity(forkRef))

  const catalog = new SessionCatalog([provider])
  const refs = await catalog.scan()
  assert.deepEqual(
    refs.map((ref) => [ref.path, ref.title]),
    [
      [fork, "Q1. Who is the user"],
      [original, "Mako Relay Investigation"],
    ],
    "both rows are listed, newest first, and the original is not hidden"
  )

  // Continuing the original through the SDK copies its store under an SDK
  // agent whose index row records the import. The catalog then shows the
  // agent in the original's place — one row, the legacy identity — and the
  // chats fork stays its own row.
  const sdkRoot = join(home, ".mako", "cursor-sdk")
  const agentDirectory = join(sdkRoot, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  await mkdir(agentDirectory, { recursive: true })
  await copyFile(original, join(agentDirectory, "store.db"))
  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"
  )
  index
    .prepare(
      "INSERT INTO agents (agent_id, workspace_ref, status, latest_checkpoint_ref_json, name, metadata_json, created_at, updated_at) VALUES (?, ?, 'IDLE', ?, 'Mako Relay Investigation', ?, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:03.000Z')"
    )
    .run(
      id,
      home,
      JSON.stringify({ blobId: "root", storeKind: "local-agent-store" }),
      JSON.stringify({ makoImport: { path: original, identity: id, agentId: id }, blobEncryptionKey: "a2V5" })
    )
  index.close()
  const importedProvider = new CursorProvider(home, {})
  const importedFiles = await importedProvider.discover()
  const importedPath = join(agentDirectory, "store.db")
  const importedRef = await importedProvider.peek(importedFiles.find((file) => file.path === importedPath))
  assert.equal(importedRef.nativeId, id, "the imported agent keeps the session id")
  assert.equal(importedRef.identity, id, "and the legacy row's identity")
  assert.equal(threadIdentity(importedRef), threadIdentity(originalRef), "so the catalog folds the two")
  const after = await new SessionCatalog([importedProvider]).scan()
  assert.deepEqual(
    after.map((ref) => [ref.path, ref.title]),
    [
      [importedPath, "Mako Relay Investigation"],
      [fork, "Q1. Who is the user"],
    ],
    "the SDK agent stands in for the acp-sessions store; the chats fork is still its own row"
  )
  console.log("Cursor fork: an acp-sessions store and its chats continuation are two rows with one agent id; an SDK import takes the original's place")
} finally {
  await rm(home, { recursive: true, force: true })
}
