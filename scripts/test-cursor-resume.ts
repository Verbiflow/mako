import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  CURSOR_SDK_IMPORT_METADATA_KEY,
  cursorLegacyIdentity,
  cursorSdkAgentDirectory,
  cursorSdkIndexPath,
  cursorSdkStateRoot,
  cursorSdkStorePath,
  cursorStoreOrigin,
} from "@mako/sessions"
import type { ProviderBinding } from "../electron/contracts/conversation-control.ts"
import { CursorSdkAuth } from "../electron/providers/cursor/sdk/auth.ts"
import { CursorCredentialStore } from "../electron/providers/cursor/sdk/credentials.ts"
import { createCursorSdkDriver } from "../electron/providers/cursor/sdk/driver.ts"
import {
  CursorImportError,
  copyLegacyStore,
  importedAgentDocument,
  readLegacyStoreMeta,
  resolveImportAgentId,
} from "../electron/providers/cursor/sdk/import.ts"
import { cursorLegacyCheckpoint, cursorSdkCheckpoint } from "../electron/providers/cursor/resume.ts"

/**
 * Cursor resumes through the SDK, whichever process wrote the store. An SDK
 * agent checkpoints by the root in `index.db`; a `cursor-agent` store by the
 * root in its own meta row; and a `cursor-agent` store is continued by
 * importing it under an SDK agent, once.
 */

const home = mkdtempSync(join(tmpdir(), "mako-fixture-cursor-resume-"))
const stateRoot = cursorSdkStateRoot({}, home)
const legacyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

function writeLegacyStore(path: string, root: string, blobs: number, hex: boolean, extra: Record<string, string> = {}) {
  mkdirSync(join(path, ".."), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    db.exec("DELETE FROM blobs")
    for (let index = 0; index < blobs; index += 1)
      db.prepare("INSERT INTO blobs VALUES (?, ?)").run(`blob-${index}`, Buffer.from("x"))
    const meta = JSON.stringify({ agentId: legacyId, latestRootBlobId: root, name: "Test", ...extra })
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(hex ? Buffer.from(meta, "utf8").toString("hex") : meta)
  } finally {
    db.close()
  }
}

try {
  const acpPath = join(home, ".cursor", "acp-sessions", legacyId, "store.db")
  const chatsPath = join(home, ".cursor", "chats", "hash", legacyId, "store.db")

  // Store origins: the three writers, told apart by path alone.
  assert.deepEqual(cursorStoreOrigin(acpPath, { home }), { origin: "acp-sessions", sessionId: legacyId })
  assert.deepEqual(cursorStoreOrigin(chatsPath, { home }), { origin: "chats", sessionId: legacyId })
  assert.deepEqual(cursorStoreOrigin(join(stateRoot, "agents", "agent-abc", "store.db"), { home }), {
    origin: "sdk",
    directoryName: "agent-abc",
  })
  assert.equal(cursorStoreOrigin(join(home, ".cursor", "acp-sessions", legacyId, "meta.json"), { home }), null)
  assert.equal(cursorStoreOrigin(join(home, "elsewhere", "store.db"), { home }), null)
  assert.equal(cursorLegacyIdentity({ origin: "acp-sessions", sessionId: legacyId }, legacyId), legacyId)
  assert.equal(cursorLegacyIdentity({ origin: "chats", sessionId: legacyId }, legacyId), `chats:${legacyId}`)

  // Legacy checkpoints: the root blob through hex or plain meta, never a file hash.
  writeLegacyStore(acpPath, "root-1", 2, false)
  const first = cursorLegacyCheckpoint(acpPath, legacyId)
  assert.ok(first, "an acp-sessions store has a checkpoint")
  writeLegacyStore(acpPath, "root-1", 2, true)
  assert.equal(cursorLegacyCheckpoint(acpPath, legacyId), first, "hex-encoded meta reads the same")
  writeLegacyStore(acpPath, "root-2", 3, true, { blobEncryptionKey: "a2V5" })
  const second = cursorLegacyCheckpoint(acpPath, legacyId)
  assert.ok(second && second !== first, "a new turn moves the root blob and the checkpoint")

  // Import helpers: the meta is read whole, the copy folds the WAL in, and
  // the index document carries Mako's record plus the blob key.
  const meta = readLegacyStoreMeta(acpPath)
  assert.equal(meta.latestRootBlobId, "root-2")
  assert.equal(meta.blobEncryptionKey, "a2V5")
  assert.throws(() => readLegacyStoreMeta(join(home, "missing.db")), CursorImportError)
  const copied = copyLegacyStore(acpPath, stateRoot, legacyId)
  assert.equal(copied, cursorSdkStorePath(stateRoot, legacyId))
  {
    const db = new DatabaseSync(copied, { readOnly: true })
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n, 3, "every blob came across")
    } finally {
      db.close()
    }
  }
  const source = { path: acpPath, identity: legacyId, cwd: "/repo", name: "From ACP" }
  const document = importedAgentDocument({ agentId: legacyId, source, meta, now: 1_000 })
  assert.equal(document.latestRootBlobId, "root-2")
  assert.equal(document.name, "From ACP")
  assert.equal(document.createdAt, 1_000, "no createdAt in the meta: now")
  assert.deepEqual(document.sdkMetadata[CURSOR_SDK_IMPORT_METADATA_KEY], { path: acpPath, identity: legacyId, agentId: legacyId })
  assert.equal(document.sdkMetadata.blobEncryptionKey, "a2V5")

  assert.deepEqual(resolveImportAgentId(legacyId, acpPath, []), { agentId: legacyId, existing: false }, "an unused id is kept")
  assert.deepEqual(
    resolveImportAgentId(legacyId, acpPath, [{ agentId: legacyId, importedFrom: acpPath }]),
    { agentId: legacyId, existing: true },
    "the same store again opens the import it already has"
  )
  const forked = resolveImportAgentId(legacyId, chatsPath, [{ agentId: legacyId, importedFrom: acpPath }])
  assert.equal(forked.existing, false)
  assert.notEqual(forked.agentId, legacyId, "the chats fork of an imported ACP session gets its own agent")
  assert.deepEqual(
    resolveImportAgentId(legacyId, chatsPath, [{ agentId: legacyId, importedFrom: acpPath }, { agentId: forked.agentId, importedFrom: chatsPath }]),
    { agentId: forked.agentId, existing: true }
  )
  assert.equal(resolveImportAgentId(legacyId, acpPath, [{ agentId: legacyId }]).existing, false, "an SDK agent that merely shares the id is not the import")
  rmSync(cursorSdkAgentDirectory(stateRoot, legacyId), { recursive: true, force: true })

  // SDK checkpoints: the root lives in index.db, the count in the store.
  const agentId = "agent-fixture-1"
  const directoryName = cursorSdkAgentDirectory(stateRoot, agentId).split("/").at(-1) ?? ""
  mkdirSync(stateRoot, { recursive: true })
  const index = new DatabaseSync(cursorSdkIndexPath(stateRoot))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, active_run_id TEXT, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"
  )
  const setRoot = (blobId: string) =>
    index
      .prepare(
        "INSERT INTO agents (agent_id, workspace_ref, status, latest_checkpoint_ref_json, name, created_at, updated_at) VALUES (?, '/repo', 'IDLE', ?, 'Fixture', '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z') ON CONFLICT(agent_id) DO UPDATE SET latest_checkpoint_ref_json = excluded.latest_checkpoint_ref_json"
      )
      .run(agentId, JSON.stringify({ blobId, storeKind: "local-agent-store" }))
  mkdirSync(cursorSdkAgentDirectory(stateRoot, agentId), { recursive: true })
  const sdkStorePath = cursorSdkStorePath(stateRoot, agentId)
  const store = new DatabaseSync(sdkStorePath)
  store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);")
  store
    .prepare("INSERT INTO meta (key, value) VALUES ('0', ?)")
    .run(Buffer.from(JSON.stringify({ agentId, latestRootBlobId: "", name: "Fixture" })).toString("hex"))
  store.prepare("INSERT INTO blobs (id, data) VALUES ('b1', x'00')").run()

  assert.equal(cursorSdkCheckpoint(stateRoot, directoryName), undefined, "no index row yet: no checkpoint")
  setRoot("root-1")
  const sdkFirst = cursorSdkCheckpoint(stateRoot, directoryName)
  assert.ok(sdkFirst, "a root in the index makes the store checkpointable")
  assert.equal(cursorSdkCheckpoint(stateRoot, directoryName), sdkFirst, "stable while nothing moves")
  setRoot("root-2")
  store.prepare("INSERT INTO blobs (id, data) VALUES ('b2', x'00')").run()
  const sdkSecond = cursorSdkCheckpoint(stateRoot, directoryName)
  assert.ok(sdkSecond && sdkSecond !== sdkFirst, "a new turn moves the checkpoint")

  // The driver's verdicts, for both kinds of store.
  const auth = new CursorSdkAuth({
    env: async () => ({}),
    openUrl: async () => undefined,
    credentials: new CursorCredentialStore(join(stateRoot, "credential.bin"), {
      available: async () => false,
      encrypt: async () => Buffer.alloc(0),
      decrypt: async () => "",
    }),
    cliKey: async () => null,
  })
  const driver = createCursorSdkDriver({ auth, stateRoot: () => stateRoot, home })
  assert.ok(driver.resumeVerdict && driver.checkpoint)
  const sdkBinding: ProviderBinding = { id: "b1", provider: "cursor", nativeId: agentId, path: sdkStorePath, checkpoint: sdkSecond, coveredBlocks: 1, includesBase: true }
  assert.deepEqual(await driver.resumeVerdict(sdkBinding), { kind: "resumable", record: "same" })
  assert.deepEqual(await driver.resumeVerdict({ ...sdkBinding, checkpoint: sdkFirst }), { kind: "resumable", record: "moved" })
  assert.deepEqual(await driver.resumeVerdict({ ...sdkBinding, checkpoint: undefined }), { kind: "resumable", record: "same" }, "a binding without a checkpoint reopens the store")
  assert.equal(await driver.checkpoint(sdkStorePath), sdkSecond, "the catalog path reads the same head")

  const acpBinding: ProviderBinding = { id: "b2", provider: "cursor", nativeId: legacyId, path: acpPath, checkpoint: second, coveredBlocks: 1, includesBase: true }
  assert.deepEqual(await driver.resumeVerdict(acpBinding), { kind: "resumable", record: "same" }, "an ACP store resumes: the SDK imports it")
  assert.deepEqual(await driver.resumeVerdict({ ...acpBinding, checkpoint: first }), { kind: "resumable", record: "moved" })
  writeLegacyStore(chatsPath, "root-9", 1, true)
  assert.equal((await driver.resumeVerdict({ ...acpBinding, path: chatsPath })).kind, "resumable", "a chats store resumes the same way")
  assert.equal((await driver.resumeVerdict({ ...acpBinding, path: join(home, "elsewhere", "store.db") })).kind, "unavailable", "a store outside Cursor's roots is not Cursor's")
  assert.equal((await driver.resumeVerdict({ ...acpBinding, path: undefined })).kind, "unavailable")
  rmSync(acpPath)
  assert.equal((await driver.resumeVerdict(acpBinding)).kind, "unavailable", "a missing store cannot be resumed")
  index.close()
  store.close()
  console.log(
    "Cursor resume: SDK agents checkpoint by index root, cursor-agent stores by meta root; acp-sessions and chats stores resume through import, once per store, with the chats fork under its own agent"
  )
} finally {
  rmSync(home, { recursive: true, force: true })
}
