import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, truncateSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { cursorSdkIndexPath, cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"
import type { ProviderBinding } from "@mako/host/contracts/conversation-control"
import { readClaudeTurn } from "@mako/host/harnesses/claude/turn-outcome"
import { readCodexTurn } from "@mako/host/harnesses/codex/turn-outcome"
import { cursorTurnReader } from "@mako/host/harnesses/cursor/turn-outcome"
import { readOpenCodeTurn } from "@mako/host/harnesses/opencode/resume-store"

const root = mkdtempSync(join(tmpdir(), "mako-native-outcomes-"))
const stores = new NativeStores(true)
const binding = (provider: string, path: string, nativeId = "native"): ProviderBinding => ({ id: "binding", provider, path, nativeId, includesBase: true, coveredBlocks: 0 })
try {
  for (const harness of ["codex", "claude"] as const) {
    const read = harness === "codex" ? readCodexTurn : readClaudeTurn
    const path = join(root, `${harness}.jsonl`)
    const start = harness === "codex"
      ? [{ type: "session_meta", payload: { id: "native" } }, { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }]
      : [{ type: "user", sessionId: "native", uuid: "turn", message: { content: "Question" } }]
    const end = harness === "codex"
      ? { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } }
      : { type: "assistant", sessionId: "native", uuid: "answer", parentUuid: "turn", message: { content: [], stop_reason: "end_turn" } }
    const write = (rows: unknown[]) => writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
    const target = { binding: binding(harness, path), runId: "turn" }
    write(start)
    assert.equal((await read(target)).kind, "unfinished")
    write([...start, end])
    assert.equal((await read(target)).kind, "completed")
    assert.equal((await read({ ...target, runId: "other" })).kind, "unknown", "another turn's answer proves nothing")
    assert.equal((await read({ ...target, binding: { ...target.binding, nativeId: "other" } })).kind, "unavailable")
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":')
    assert.equal((await read(target)).kind, "unknown", "a partial native record is not proof of completion")
    truncateSync(path, 33 * 1024 * 1024)
    assert.equal((await read(target)).kind, "unknown", "the optional scan's size ceiling cannot block a verified native continuation")
    const changed = harness === "codex" ? { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } } : { type: "last-prompt", explicit: true }
    write([...start, end, changed])
    assert.equal((await read(target)).kind, "unknown", "a rewind requires its own active-branch proof")
  }
  const cursor = join(root, "cursor")
  const cursorPath = cursorSdkStorePath(cursor, "native")
  mkdirSync(dirname(cursorPath), { recursive: true })
  writeFileSync(cursorPath, "")
  const index = new DatabaseSync(cursorSdkIndexPath(cursor))
  try {
    index.exec("CREATE TABLE agents(agent_id TEXT); INSERT INTO agents VALUES('native'); CREATE TABLE runs(run_id TEXT, agent_id TEXT, turn_number INTEGER, status TEXT); INSERT INTO runs VALUES('turn','native',1,'RUNNING')")
    const read = cursorTurnReader(stores, () => cursor, root)
    const target = { binding: binding("cursor", cursorPath), runId: "turn" }
    assert.equal((await read(target)).kind, "unfinished")
    index.exec("UPDATE runs SET status='FINISHED'")
    assert.equal((await read(target)).kind, "completed")
    assert.equal((await read({ ...target, runId: "other" })).kind, "unknown")
    index.exec("UPDATE runs SET status='CANCELLED'")
    assert.equal((await read(target)).kind, "unknown", "native cancellation is not proof that the work completed")
    index.exec("UPDATE runs SET status='FINISHED'; INSERT INTO runs VALUES('later','native',2,'FINISHED')")
    assert.equal((await read(target)).kind, "unknown", "a later turn is not exact completion evidence for the old one")
  } finally { index.close() }
  const path = join(root, "opencode-next.db")
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TABLE session_v2(id TEXT); INSERT INTO session_v2 VALUES('native'); CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,data TEXT); INSERT INTO session_message VALUES('turn','native','user',1,'{}')")
    const read = () => readOpenCodeTurn(stores, `${path}#v2:native`, "native", "turn")
    assert.equal(read().kind, "unfinished")
    db.prepare("INSERT INTO session_message VALUES('answer','native','assistant',2,?)").run(JSON.stringify({ finish: "stop" }))
    assert.equal(read().kind, "completed")
    assert.equal(readOpenCodeTurn(stores, `${path}#v2:native`, "native", "other").kind, "unknown")
    db.exec("CREATE TABLE session_pending(session_id TEXT); INSERT INTO session_pending VALUES('native')")
    assert.equal(read().kind, "unavailable", "reopening may execute native pending inputs; no speculative dispatch")
    db.exec("DELETE FROM session_pending; INSERT INTO session_message VALUES('later','native','user',3,'{}')")
    assert.equal(read().kind, "unknown")
  } finally { db.close() }
  console.log("PASS: four actual native readers distinguish exact completion, unfinished input, source/turn mismatch, cancellation/rewind, partial records and native pending inputs")
} finally { rmSync(root, { recursive: true, force: true }) }
