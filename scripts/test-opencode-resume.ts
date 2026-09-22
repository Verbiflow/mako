import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readOpenCodeResumeRecord } from "../electron/providers/opencode/resume-store.ts"
import { resumeVerdict, type NativeResumeReader } from "../electron/native-continuation.ts"
import { resumable, type ProviderBinding } from "../electron/contracts/conversation-control.ts"
import type { ProviderProcessProbe } from "../electron/providers/process-probe.ts"

const root = await mkdtemp(join(tmpdir(), "mako-opencode-resume-"))
const idle: ProviderProcessProbe = { provider: "opencode", probe: async () => ({ kind: "available", sessions: [] }) }
const read: NativeResumeReader = async binding => readOpenCodeResumeRecord(binding.path!, binding.nativeId!)
try {
  for (const layout of ["legacy", "mixed-v2", "current"] as const) {
    const path = join(root, layout === "current" ? "opencode-next.db" : `${layout}.db`)
    const db = new DatabaseSync(path)
    try {
      const table = layout === "mixed-v2" ? "session_v2" : "session"
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE session_pending (id TEXT PRIMARY KEY, session_id TEXT);
        CREATE TABLE session_inbox (id TEXT PRIMARY KEY, session_id TEXT);`)
      db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run("ses_one", "First")
      db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run("ses_other", "Other")
      const content = layout === "legacy" ? "part" : "session_message"
      db.prepare(`INSERT INTO ${content} VALUES (?, ?, ?)`).run("msg_one", "ses_one", "original content")
      const binding: ProviderBinding = { id: "fixture", provider: "opencode", nativeId: "ses_one", path: `${path}#${layout === "mixed-v2" ? "v2:" : ""}ses_one`, includesBase: true, coveredBlocks: 1 }
      const initial = await read(binding)
      assert.equal(initial.kind, "available", layout)
      if (initial.kind !== "available") throw new Error(initial.reason)
      assert.equal((await resumeVerdict(binding, idle)).kind, "unavailable", "the former generic file fallback cannot read a database-row locator")
      assert.deepEqual(await resumeVerdict(binding, idle, read), { kind: "resumable", record: "unknown" })
      assert.equal(resumable(await resumeVerdict(binding, idle, read), "same"), false)
      binding.checkpoint = initial.checkpoint
      assert.deepEqual(await resumeVerdict(binding, idle, read), { kind: "resumable", record: "same" })
      db.prepare(`INSERT INTO ${content} VALUES (?, ?, ?)`).run("msg_other", "ses_other", "unrelated change")
      assert.deepEqual(await read(binding), initial, "another session's write must not change this checkpoint")
      db.prepare(`UPDATE ${content} SET data=? WHERE id=?`).run("modified content", "msg_one")
      assert.deepEqual(await resumeVerdict(binding, idle, read), { kind: "resumable", record: "moved" }, "same-count edits must change history evidence")
      assert.equal((await read({ ...binding, nativeId: "ses_wrong" })).kind, "unavailable")
      assert.equal((await read({ ...binding, nativeId: "ses_missing", path: `${path}#${layout === "mixed-v2" ? "v2:" : ""}ses_missing` })).kind, "unavailable")
      for (const state of ["active", "open"] as const) {
        assert.equal((await resumeVerdict(binding, { ...idle, probe: async () => ({ kind: "available", sessions: [{ nativeId: "ses_one", status: state }] }) }, read)).kind, "held")
      }
      assert.equal((await resumeVerdict(binding, undefined, read)).kind, "unavailable")
      assert.equal((await resumeVerdict(binding, { ...idle, probe: async () => ({ kind: "unavailable", reason: "failed" }) }, read)).kind, "unavailable")
      if (layout !== "legacy") {
        for (const pending of ["session_pending", "session_inbox"]) {
          db.prepare(`INSERT INTO ${pending} VALUES (?, ?)`).run("pending", "ses_one")
          assert.equal((await read(binding)).kind, "unavailable", "native admitted input must be reconciled before loading")
          db.exec(`DELETE FROM ${pending}`)
        }
      }
    } finally { db.close() }
  }
  assert.equal(readOpenCodeResumeRecord("/missing.db#%zz", "ses_one").kind, "unavailable")
  console.log("OpenCode recovery: three store layouts, matching identity, consistent session-scoped fingerprints, old/moved history, ownership and native pending-input refusal")
} finally { await rm(root, { recursive: true, force: true }) }
