import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  acpReadable,
  acpSessionNotificationSchema,
  acpWritable,
  screenSessionUpdates,
  type LossySessionUpdate,
  type RefusedSessionUpdate,
} from "../electron/acp-stream.ts"
import type { JsonObject } from "../electron/codex-app-json.ts"

// A provider that closed its stdin but is still running: a write fails with
// EPIPE, which Node reports through the callback and as a pipe `error` event.
const child = spawn("sh", ["-c", "exec 0<&-; sleep 2"], {
  stdio: ["pipe", "pipe", "pipe"],
})
const uncaught: Error[] = []
const observe = (error: Error) => uncaught.push(error)
process.on("uncaughtException", observe)
try {
  await new Promise<void>((resolve) => setTimeout(resolve, 200))
  const writer = acpWritable(child.stdin).getWriter()
  await assert.rejects(
    writer.write(new Uint8Array(70_000).fill(120)),
    (error: NodeJS.ErrnoException) => error.code === "EPIPE"
  )
  await assert.rejects(writer.write(new Uint8Array([10])))
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(uncaught, [], "A closed provider stdin must not crash the host")
} finally {
  process.off("uncaughtException", observe)
  child.kill()
}

const echo = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] })
const reader = acpReadable(echo.stdout).getReader()
const writer = acpWritable(echo.stdin).getWriter()
await writer.write(new TextEncoder().encode("ping\n"))
const first = await reader.read()
assert.equal(new TextDecoder().decode(first.value), "ping\n")
await writer.close()
const rest: string[] = []
for (let next = await reader.read(); !next.done; next = await reader.read())
  rest.push(new TextDecoder().decode(next.value))
assert.deepEqual(rest, [])
console.log(
  "ACP streams: a closed provider stdin rejects the pending write and errors the stream without an uncaught exception; open pipes round-trip and close cleanly"
)

assert.ok(await acpSessionNotificationSchema(), "the SDK's own session/update schema loads from the installed package")
const update = (value: JsonObject) => ({ jsonrpc: "2.0" as const, method: "session/update", params: { sessionId: "s", update: value } })
const sent = [
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "kept" } }),
  update({ sessionUpdate: "auto_compact_started", tokens_used: 1 }),
  update({ sessionUpdate: "tool_call", toolCallId: "no-title" }),
  { jsonrpc: "2.0" as const, method: "_x.ai/session_notification", params: { anything: true } },
  { jsonrpc: "2.0" as const, id: 1, result: { stopReason: "end_turn" } },
  { jsonrpc: "2.0" as const, method: "session/update", params: "not an object" },
]
const refused: RefusedSessionUpdate[] = []
const screened = await screenSessionUpdates({ readable: ReadableStream.from(sent), writable: new WritableStream() }, (value) => refused.push(value))
const passed = await Array.fromAsync(screened.readable)
assert.deepEqual(passed, [sent[0], sent[3], sent[4]], "valid updates, other notifications and responses reach the SDK in order")
assert.deepEqual(refused.map(({ kind, known }) => ({ kind, known })), [
  { kind: "auto_compact_started", known: false },
  { kind: "tool_call", known: true },
  { kind: "(none)", known: false },
], "everything the SDK would reject is handed back with the kind it claimed")
assert.deepEqual(refused[0]?.params, sent[1]?.params, "a refused update keeps its params for the provider's decoder")
console.log("ACP streams: session/update the SDK would reject is screened out and handed back, and everything else passes through untouched")

const bent = [
  update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "blocked", title: null }),
  update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Read", kind: "teleport", status: "pending" }),
  update({ sessionUpdate: "plan", entries: [{ content: "a", priority: "high", status: "paused" }, { content: "b", priority: "high", status: "pending" }] }),
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" }, extra: 1 }),
  update({ sessionUpdate: "tool_call", toolCallId: "u", title: "Read", kind: "read", status: "pending", content: [{ type: "content", content: { type: "text", text: "x" } }], _meta: { a: 1 } }),
]
const lossy: LossySessionUpdate[] = []
const kept = await Array.fromAsync((await screenSessionUpdates({ readable: ReadableStream.from(bent), writable: new WritableStream() }, () => assert.fail("nothing here is refused"), (value) => lossy.push(value))).readable)
assert.deepEqual(kept, bent, "a lossy update still reaches the SDK")
assert.deepEqual(lossy, [
  { kind: "tool_call_update", paths: ["status"] },
  { kind: "tool_call", paths: ["kind"] },
  { kind: "plan", paths: ["entries[]"] },
  { kind: "agent_message_chunk", paths: ["extra"] },
], "an unknown value, a dropped entry and a stripped field each name where they were lost, and a whole update names nothing")
console.log("ACP streams: a session/update the SDK keeps only in part names the values it lost")
