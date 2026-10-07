import assert from "node:assert/strict"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readOpenCodeResumeRecord } from "../electron/providers/opencode/resume-store.ts"
import { resumeVerdict, type NativeResumeReader } from "../electron/native-continuation.ts"
import { resumable, type ProviderBinding } from "../electron/contracts/conversation-control.ts"
import type { ProviderProcessProbe } from "../electron/providers/process-probe.ts"
import { sameNativeSource } from "../electron/native-source.ts"
import { providerHost } from "../electron/providers/index.ts"
import { createOpenCodeDriver, openCodeForkBoundary, openCodeSessionMessages } from "../electron/providers/opencode/live-driver.ts"
import { errorMessage } from "../electron/live-runtime.ts"
import { locateOpenCodeSession, verifyOpenCodeSession } from "../electron/providers/opencode/installation.ts"

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
      if (layout === "legacy") {
        assert.equal(initial.kind, "unavailable")
        if (initial.kind === "unavailable") assert.match(initial.reason, /v1 sessions are no longer supported/)
        continue
      }
      assert.equal(initial.kind, "available", layout)
      const alias = join(root, `${layout}-alias.db`)
      await symlink(path, alias)
      const aliasPath = `${alias}#${layout === "mixed-v2" ? "v2:" : ""}ses_one`
      assert.deepEqual(await read({ ...binding, path: aliasPath }), initial, "DB aliases preserve schema and native source evidence")
      const driver = providerHost.liveDrivers.get("opencode")!
      assert.equal(await sameNativeSource(driver, binding.path!, aliasPath, binding.nativeId), true)
      assert.equal(await sameNativeSource(driver, binding.path!, `${alias}#v2:ses_other`, binding.nativeId), false, "a matching physical DB cannot authorize another native record")
      assert.equal(await sameNativeSource(driver, binding.path!, `${alias}#v2:ses_one`, binding.nativeId), layout === "mixed-v2", "schema namespaces cannot collapse into one identity")
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
      for (const pending of ["session_pending", "session_inbox"]) {
        db.prepare(`INSERT INTO ${pending} VALUES (?, ?)`).run("pending", "ses_one")
        assert.equal((await read(binding)).kind, "unavailable", "native admitted input must be reconciled before loading")
        db.exec(`DELETE FROM ${pending}`)
      }
      if (layout === "mixed-v2") {
        const located = createOpenCodeDriver({ env: async () => ({}), approvalRoot: async () => root })
        const resume = located.resume
        assert.ok(resume.kind === "native" && resume.locate)
        assert.equal(await resume.locate({ ...binding, path: undefined }, root, { OPENCODE_DB: path }), binding.path, "a binding that lost its path finds its record by native ID in the configured store")
        await assert.rejects(resume.locate({ ...binding, path: undefined, nativeId: "ses_missing" }, root, { OPENCODE_DB: path }), /could not be resolved/)
        db.prepare("INSERT INTO session_inbox VALUES (?, ?)").run("starting", "ses_one")
        assert.equal(await locateOpenCodeSession("ses_one", { OPENCODE_DB: path }), binding.path, "a session OpenCode is still starting, with an input waiting, is found where it lives")
        await assert.rejects(verifyOpenCodeSession("ses_one", undefined, { OPENCODE_DB: path }), /inputs awaiting execution/, "but is not loaded over that input")
        db.exec("DELETE FROM session_inbox")
        assert.equal(await verifyOpenCodeSession("ses_one", undefined, { OPENCODE_DB: path }), binding.path)
      }
    } finally { db.close() }
  }
  assert.equal(readOpenCodeResumeRecord("/missing.db#%zz", "ses_one").kind, "unavailable")
  const turns = [
    { id: "a0", type: "agent-switched" }, { id: "u1", type: "user" }, { id: "r1", type: "assistant" },
    { id: "a1", type: "agent-switched" }, { id: "s1", type: "synthetic" }, { id: "u2", type: "user" }, { id: "r2", type: "assistant" },
  ]
  assert.deepEqual(openCodeForkBoundary(turns, "u1"), { type: "before", messageID: "a1" }, "a fork keeps its turn and drops the switches that opened the next one")
  assert.deepEqual(openCodeForkBoundary(turns, "u2"), { type: "through" }, "a fork from the last turn keeps the whole session")
  assert.deepEqual(openCodeForkBoundary([{ id: "u1", type: "user" }, { id: "u2", type: "user" }], "u1"), { type: "before", messageID: "u2" }, "a turn with no answer yet still ends at the next one")
  assert.throws(() => openCodeForkBoundary(turns, "u9"), /not in OpenCode's session/)
  // OpenCode 2.0.1 names a next page even after the last, and refuses a cursor sent with an order.
  const stored = Array.from({ length: 450 }, (_, index) => ({ id: `m${index}`, type: index % 2 ? "assistant" : "user" }))
  const pages: unknown[] = []
  const list = async (input: { order?: string; limit: number; cursor?: string }) => {
    pages.push(input)
    if (input.cursor && input.order) throw { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" }
    const start = input.cursor ? Number(input.cursor) : 0
    return { data: stored.slice(start, start + input.limit), cursor: { next: String(start + input.limit) } }
  }
  assert.deepEqual((await openCodeSessionMessages(list, "ses_one")).map(message => message.id), stored.map(message => message.id), "every page, in order")
  assert.equal(pages.length, 3, "and no page after a short one")
  assert.equal(errorMessage({ error: { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" } }), "Cursor cannot be combined with order", "a tagged rejection says what it was")
  console.log("OpenCode recovery: three store layouts, matching identity, consistent session-scoped fingerprints, old/moved history, ownership, native pending-input refusal, lookup by native ID and fork boundaries")
} finally { await rm(root, { recursive: true, force: true }) }
