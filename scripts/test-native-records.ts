import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { installHostLog } from "../electron/host-log.ts"
import { capturesHarness, NATIVE_CAPTURE_ENV, nativeCapture } from "../electron/native-capture.ts"
import { flushUnknown, nativeUnknownPath, retainUnknown, unknownKinds } from "../electron/native-unknown.ts"
import { decoderFor, decodeSession, readRecording } from "./native-decoding.ts"

/**
 * The two records a decoder leaves for whoever adds the next translation:
 * unknown native records kept beside the host log, and opt-in captures that
 * replay through the decoder as they arrived.
 */

const root = await mkdtemp(join(tmpdir(), "mako-native-records-"))
const log = installHostLog(join(root, "host.log"))

{
  const raw = { threadId: "thread-1", header: "Bearer sk-live-0123456789abcdef" }
  retainUnknown("codex", "future/notification", "unknown", raw)
  retainUnknown("codex", "future/notification", "unknown", raw)
  retainUnknown("codex", "item/commandExecution/invalid", "unreadable", { item: { type: "commandExecution" } })
  retainUnknown("claude", "stream_event/unknown", "unknown")
  await flushUnknown()
  await log.flush()

  const kept = (await readFile(nativeUnknownPath()!, "utf8")).trim().split("\n").map((line) => z.json().parse(JSON.parse(line)))
  const LineSchema = z.object({ harness: z.string(), kind: z.string(), reason: z.string(), record: z.json() })
  const lines = kept.map((line) => LineSchema.parse(line))
  assert.deepEqual(lines.map((line) => [line.harness, line.kind, line.reason]), [
    ["codex", "future/notification", "unknown"],
    ["codex", "item/commandExecution/invalid", "unreadable"],
  ], "the first record of each kind is kept; a repeat is counted, and a kind without a record is only counted")
  assert.deepEqual(lines[0]!.record, { threadId: "thread-1", header: "Bearer …" }, "a kept record is scrubbed of bearer tokens")
  assert.deepEqual(unknownKinds().map((kind) => [kind.kind, kind.count]), [
    ["future/notification", 2],
    ["item/commandExecution/invalid", 1],
    ["stream_event/unknown", 1],
  ])
  const host = await readFile(log.path, "utf8")
  assert.equal(host.match(/native event not handled harness=codex kind=future\/notification/g)?.length, 1, "the host log names a kind once")
  assert.match(host, /native event unreadable harness=codex kind=item\/commandExecution\/invalid kept=native-unknown.jsonl/)
  console.log("PASS: unknown native records are kept once per kind, counted and scrubbed")
}

{
  assert.equal(capturesHarness("codex", undefined), false, "capture is off by default")
  assert.equal(capturesHarness("codex", "claude, codex"), true)
  assert.equal(capturesHarness("cursor", "all"), true)
  delete process.env[NATIVE_CAPTURE_ENV]
  assert.equal(nativeCapture("codex", "conversation", () => ({})), null)

  process.env[NATIVE_CAPTURE_ENV] = "codex"
  let threadId: string | null = null
  const capture = nativeCapture("codex", "conversation/1", () => ({ threadId }))
  assert.ok(capture)
  assert.match(capture.path, /native-captures\/codex-conversation_1-.+\.jsonl$/, "one file per conversation, beside the host log")
  threadId = "thread-1"
  const messages = [
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "a", delta: "token=abc123 stays private" } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, items: [] } } },
  ]
  for (const message of messages) capture.record(message)
  await capture.flush()
  delete process.env[NATIVE_CAPTURE_ENV]

  const recording = await readRecording(capture.path)
  assert.equal(recording.harness, "codex")
  assert.deepEqual(recording.session, { threadId: "thread-1" }, "the header holds what the driver knew at the first message")
  assert.equal(recording.messages.length, 3)
  assert.match(JSON.stringify(recording.messages[1]), /token=… stays private/, "captured content is scrubbed of token values")
  const steps = decodeSession(decoderFor("codex"), recording.session, recording.messages)
  assert.deepEqual(steps.map((step) => step.kind), ["turn/started", "item/agentMessage/delta", "turn/completed"])
  assert.ok(steps[1]!.decoded.length, "a captured session decodes as it arrived")
  console.log("PASS: an opt-in capture records a conversation and replays through its decoder")
}

assert.throws(() => decoderFor("claude"), /claude has no decoder yet: .+\. Decoders: codex/, "a harness without a decoder says why")
assert.throws(() => decoderFor("nope"), /No harness named nope/)
await rm(root, { recursive: true, force: true })
console.log("PASS: native records")
