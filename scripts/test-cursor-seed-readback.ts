import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { cursorSdkIndexPath, cursorSdkStateRoot, type ThreadPage } from "@mako/sessions"
import { emitCursorSession } from "../packages/sessions/src/emit.ts"
import { CursorProvider } from "../packages/sessions/src/providers/cursor.ts"
import { readLegacyStoreSnapshot } from "@mako/host/harnesses/cursor/legacy-store"
import { copyLegacyStore, importedAgentDocument } from "@mako/host/harnesses/cursor/sdk/import"
import { withSeed } from "@mako/host/conversations/native-history"
import { seeded, seedThread } from "./lib/seed-readback.ts"

// A Cursor fork resumes from the SDK's copy of the store Mako wrote, so the
// conversation reads that copy: it must begin with the seed exactly as the
// written store read back, or the conversation would show the harness's text.
const home = mkdtempSync(join(tmpdir(), "mako-cursor-seed-"))
try {
  const thread = seedThread(join(home, "project"))
  const emitted = await emitCursorSession(thread, { home })
  const seed = seeded(thread, await new CursorProvider(home, {}).read(emitted.path))
  const stateRoot = cursorSdkStateRoot({}, home)
  const copied = copyLegacyStore(emitted.path, stateRoot, emitted.sessionId)
  const document = importedAgentDocument({
    agentId: emitted.sessionId, source: { path: emitted.path, identity: emitted.sessionId },
    snapshot: readLegacyStoreSnapshot(copied, emitted.sessionId), now: 0,
  })
  const index = new DatabaseSync(cursorSdkIndexPath(stateRoot))
  index.exec("CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, active_run_id TEXT, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
    "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);")
  index.prepare("INSERT INTO agents (agent_id, workspace_ref, status, latest_checkpoint_ref_json, name, metadata_json, created_at, updated_at) VALUES (?, ?, 'IDLE', ?, 'Seeded', ?, '2026-10-09T00:00:00Z', '2026-10-09T00:00:00Z')")
    .run(document.agentId, thread.ref.cwd!, JSON.stringify({ blobId: document.latestRootBlobId, storeKind: "local-agent-store" }), JSON.stringify(document.sdkMetadata))
  index.close()
  const read = await new CursorProvider(home, {}).read(copied)
  assert.ok(read, "the SDK's copy reads back")
  assert.equal(read.entries.length, seed.native, "the copy holds what was written, no more")
  const page: ThreadPage = { ref: read.ref, entries: read.entries, start: 0, total: read.entries.length, hasEarlier: false }
  const shown = withSeed(page, thread.entries, seed)
  assert.ok(shown, "the copy begins with the seed as the written store read")
  assert.deepEqual(shown.entries, thread.entries, "so the conversation shows Mako's own record, tool calls and all")
  console.log("Cursor seed readback: the SDK's copy of a seeded store reads as the written one did, so the seed shows as Mako wrote it")
} finally {
  rmSync(home, { recursive: true, force: true })
}
