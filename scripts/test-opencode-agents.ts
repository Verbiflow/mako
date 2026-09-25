import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { performance } from "node:perf_hooks"
import { readOpenCodeAgents } from "../electron/providers/opencode/agent-store.ts"
// Exercise the same compiled worker entry used by Electron, not a fake reader.
import { OpenCodeAgents } from "../dist-electron/providers/opencode/agents.js"
import type { NativeAgentObservation } from "../electron/contracts/native-agents.ts"

const root = await mkdtemp(join(tmpdir(), "mako-opencode-children-"))
await mkdir(join(root, "opencode"))
const path = join(root, "opencode", "opencode.db")
const db = new DatabaseSync(path)
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_idle INTEGER,idle_outcome TEXT);
 CREATE INDEX child_parent ON session_v2(parent_id);
 CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);
 CREATE INDEX latest_message ON session_message(session_id,type,seq);
 CREATE TABLE session_pending(id TEXT PRIMARY KEY,session_id TEXT,admitted_seq INTEGER);
 CREATE INDEX pending_session ON session_pending(session_id,admitted_seq);
 CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT,enqueued_seq INTEGER);
 CREATE INDEX inbox_session ON session_inbox(session_id,enqueued_seq);
 INSERT INTO session_v2 VALUES('ses_parent',NULL,'Parent',NULL,NULL),('ses_child','ses_parent','Child',30,'succeeded'),('ses_foreign','ses_other','Foreign',30,'succeeded');`)
const put = db.prepare("INSERT OR REPLACE INTO session_message VALUES(?,?,?,?,?,?)")
const message = (id: string, type: string, seq: number, created: number, completed: number | null, finish: string | null) => put.run(id, "ses_child", type, seq, created, JSON.stringify({ time: { completed }, finish }))
message("input-1", "user", 1, 10, null, null)
message("answer-1", "assistant", 2, 20, 29, "stop")
const read = () => readOpenCodeAgents([path], "ses_parent")
assert.equal(read().length, 1)
assert.equal(read()[0]?.state.kind, "completed")
db.exec("INSERT INTO session_pending VALUES('queued-input','ses_child',3)")
assert.equal(read()[0]?.state.kind, "working", "Admitted work cannot inherit an old idle success before input projection")
assert.equal(read()[0]?.nativeRunId, "queued-input")
db.exec("DELETE FROM session_pending")
message("input-2", "user", 3, 40, null, null)
assert.equal(read()[0]?.state.kind, "working", "Old idle success and old assistant cannot settle new input")
message("answer-2", "assistant", 4, 41, null, null)
assert.equal(read()[0]?.state.kind, "working")
message("answer-2", "assistant", 4, 41, 49, "tool-calls")
db.prepare("UPDATE session_v2 SET time_idle=50 WHERE id='ses_child'").run()
assert.equal(read()[0]?.state.kind, "working", "A completed shell tool is not child completion")
message("answer-3", "assistant", 5, 51, 59, "stop")
assert.equal(read()[0]?.state.kind, "working", "Assistant completion before idle commit remains unsettled")
db.prepare("UPDATE session_v2 SET time_idle=60 WHERE id='ses_child'").run()
assert.equal(read()[0]?.nativeRunId, "input-2")
assert.equal(read()[0]?.state.kind, "completed")
const events: NativeAgentObservation[] = []
const observer = new OpenCodeAgents({ nativeId: "ses_parent", env: { XDG_DATA_HOME: root }, publish: agent => events.push(agent) })
const notify = () => observer.observe({ sessionId: "ses_parent", toolCallId: "unrelated", status: "completed" })
async function until(check: () => boolean) {
  const end = Date.now() + 4000
  while (!check() && Date.now() < end) await delay(10)
  assert.ok(check(), "Expected worker observation")
}
try {
  await observer.ready
  assert.equal(events.at(-1)?.state.kind, "completed")
  observer.observe({ sessionId: "ses_parent", toolCallId: "resume-3", title: "subagent", rawInput: { sessionID: "ses_child" } })
  assert.equal(events.at(-1)?.state.kind, "working")
  notify(); await delay(80)
  assert.equal(events.at(-1)?.nativeRunId, "resume-3", "A queued old snapshot cannot settle admitted new work")
  message("input-3", "user", 6, 70, null, null); notify()
  await until(() => events.at(-1)?.nativeRunId === "input-3")
  assert.equal(events.at(-1)?.state.kind, "working")
  message("answer-4", "assistant", 7, 71, 79, "stop")
  db.prepare("UPDATE session_v2 SET time_idle=80 WHERE id='ses_child'").run()
  // No ACP completion notification: polling must recover committed native completion.
  await until(() => events.at(-1)?.state.kind === "completed")
  observer.observe({ sessionId: "ses_parent", toolCallId: "resume-3", status: "completed", rawOutput: { metadata: { sessionID: "ses_child", status: "running" } } })
  assert.equal(events.at(-1)?.state.kind, "completed", "Delayed launch acknowledgement cannot revive completed execution")
  observer.observe({ sessionId: "ses_parent", toolCallId: "rejected", title: "subagent", rawInput: { sessionID: "ses_child" } })
  observer.observe({ sessionId: "ses_parent", toolCallId: "rejected", status: "failed" })
  assert.equal(events.at(-1)?.nativeRunId, "input-3")
  assert.equal(events.at(-1)?.state.kind, "completed")
  observer.observe({ sessionId: "ses_parent", toolCallId: "overlap-a", title: "subagent", rawInput: { sessionID: "ses_child" } })
  observer.observe({ sessionId: "ses_parent", toolCallId: "overlap-b", title: "subagent", rawInput: { sessionID: "ses_child" } })
  message("input-overlap-a", "user", 8, 90, null, null)
  message("answer-overlap-a", "assistant", 9, 91, 99, "stop")
  db.prepare("UPDATE session_v2 SET time_idle=100 WHERE id='ses_child'").run()
  notify(); await delay(100)
  assert.equal(events.at(-1)?.nativeRunId, "overlap-b")
  assert.equal(events.at(-1)?.state.kind, "working", "Earlier admitted input cannot settle an overlapping newer attempt")
  observer.observe({ sessionId: "ses_parent", toolCallId: "overlap-a", status: "failed" })
  assert.equal(events.at(-1)?.nativeRunId, "overlap-b", "Late rejection cannot clear newer admission")
  db.exec("DELETE FROM session_message WHERE seq>7; UPDATE session_v2 SET time_idle=80 WHERE id='ses_child'")
  db.exec("BEGIN")
  for (let i = 0; i < 100_000; i++) put.run(`history-${i}`, "ses_child", "assistant", -i-1, 0, '{"time":{"completed":1},"finish":"stop","content":"old history"}')
  db.exec("COMMIT")
  const samples = []
  for (let i = 0; i < 7; i++) { const start = performance.now(); assert.equal(read()[0]?.nativeRunId, "input-3"); samples.push(performance.now() - start) }
  console.log(JSON.stringify({ scope: "indexed metadata read, one child and 100000 historical assistant rows", samplesMs: samples }))
} finally {
  observer.dispose(); db.close(); await rm(root, { recursive: true, force: true })
}
console.log("OpenCode children: current-input correlation, stale idle outcome, commit ordering, real worker, missed event, rejected admission and large-history read passed")
