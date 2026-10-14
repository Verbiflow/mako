// What reading Claude Code's transcript for task notifications costs: the
// forward reader the live driver keeps (`ClaudeTranscriptTail`) against
// reading the transcript's last 2 MB on each poll, as the driver did for a
// turn Claude started itself. A synthetic session grows as a long one does:
// replies, tool results (some of several megabytes), queue operations and a
// notification taken in now and then. Prints milliseconds and bytes read.
//
//   npx tsx scripts/benchmark-transcript-tail.ts
import { appendFileSync, mkdtempSync, openSync, readSync, closeSync, fstatSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { ClaudeTranscriptTail } from "@mako/host/harnesses/claude/transcript-tail"
import { KeptOutputs } from "@mako/sessions"
import type { JsonObject } from "@mako/host/contracts/json"

const root = mkdtempSync(join(tmpdir(), "mako-transcript-tail-bench-"))
const path = join(root, "session.jsonl")
const session = "bench-session"
writeFileSync(path, "")
const line = (record: JsonObject) => `${JSON.stringify({ sessionId: session, timestamp: new Date().toISOString(), uuid: randomUUID(), ...record })}\n`
const reply = (text: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
const result = (bytes: number) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(bytes) }] } })
const notification = (n: number) => `<task-notification>\n<task-id>bmon${n}</task-id>\n<summary>Monitor event: "CI"</summary>\n<event>check ${n}: pass</event>\n</task-notification>`

const tail = new ClaudeTranscriptTail(path, session, new KeptOutputs(join(root, "outputs.sqlite")))
const OLD_TAIL = 2 * 1024 * 1024
/** The old provider-turn read: the transcript's last 2 MB, scanned backwards for the newest prompt. */
function oldRead(): number {
  const fd = openSync(path, "r")
  try {
    const { size } = fstatSync(fd)
    const length = Math.min(size, OLD_TAIL)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return length
  } finally {
    closeSync(fd)
  }
}

let requests = 0
let found = 0
let oldBytes = 0
let oldMs = 0
let written = 0
const turns = 400
for (let turn = 0; turn < turns; turn++) {
  // A step: a reply, a tool result (every 50th a 4 MB one), and every 10th step a monitor event queued and taken in.
  let chunk = reply(`Step ${turn}: running the checks.`) + result(turn % 50 === 49 ? 4 * 1024 * 1024 : 2_000)
  if (turn % 10 === 9) {
    const text = notification(turn)
    chunk += line({ type: "queue-operation", operation: "enqueue", content: text })
    chunk += line({ type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: text, commandMode: "task-notification" } })
    chunk += line({ type: "queue-operation", operation: "remove", content: text, reason: "absorbed_mid_turn" })
  }
  appendFileSync(path, chunk)
  written += Buffer.byteLength(chunk)
  // Each step starts a model request, which reads once.
  requests++
  found += tail.read().length
  const started = performance.now()
  // The old provider-turn path polled every 50 ms for up to 1.5 s: up to 30 reads of the last 2 MB.
  oldBytes += oldRead()
  oldMs += performance.now() - started
}
const { stats } = tail
console.log(JSON.stringify({
  transcriptMB: Math.round(written / 1024 / 1024 * 10) / 10,
  requests,
  notificationsFound: found,
  tail: { reads: stats.reads, readMB: Math.round(stats.bytes / 1024 / 1024 * 10) / 10, parsedLines: stats.parsed, totalMs: Math.round(stats.ms * 10) / 10, meanMs: Math.round(stats.ms / stats.reads * 1000) / 1000, maxMs: Math.round(stats.maxMs * 10) / 10 },
  oldPerPoll: { readMB: Math.round(oldBytes / 1024 / 1024 * 10) / 10, totalMs: Math.round(oldMs * 10) / 10, perRequestWorstMB: 30 * 2 },
}, null, 1))
// Kept outputs: a body kept once when first read, read back once its file is gone; the oldest go past the budget.
const kept = new KeptOutputs(join(root, "kept.sqlite"), undefined, { copies: 2_000, bytes: 16 * 1024 * 1024 })
const output = Array.from({ length: 40 }, (_, index) => `line ${index} of the command's output, as a test runner prints it`).join("\n")
let started = performance.now()
for (let task = 0; task < 5_000; task++) kept.keep({ harness: "claude", session: "s", task: `b${task}` }, { output })
const keepMs = performance.now() - started
started = performance.now()
for (let task = 0; task < 5_000; task++) kept.keep({ harness: "claude", session: "s", task: `b${task % 2_000 + 3_000}` }, { output })
const keptAgainMs = performance.now() - started
const reader = new KeptOutputs(join(root, "kept.sqlite"))
started = performance.now()
let hits = 0
for (let task = 0; task < 5_000; task++) if (reader.read({ harness: "claude", session: "s", task: `b${task}` })) hits++
const readMs = performance.now() - started
console.log(JSON.stringify({ kept: { writes: 5_000, writeMs: Math.round(keepMs), sameAgainMs: Math.round(keptAgainMs), reads: 5_000, readMs: Math.round(readMs), hitsAfterEviction: hits, totals: reader.totals() } }, null, 1))
kept.close()
reader.close()
rmSync(root, { recursive: true, force: true })
