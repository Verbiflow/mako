import assert from "node:assert/strict"
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { JsonObject } from "../electron/codex-app-json.ts"
import { installHostLog } from "../electron/host-log.ts"
import { capturesHarness, NATIVE_CAPTURE_ENV, nativeCapture } from "../electron/native-capture.ts"
import { flushUnknown, nativeUnknownPath, retainUnknown, unknownKinds } from "../electron/native-unknown.ts"
import { providerHost } from "../electron/providers/index.ts"
import { decoderFor, decodeSession, readRecording } from "./native-decoding.ts"

/**
 * The two records a decoder leaves for whoever adds the next translation:
 * unknown native records kept beside the host log, and opt-in captures that
 * replay through the decoder as they arrived.
 */

const root = await mkdtemp(join(tmpdir(), "mako-native-records-"))
const log = installHostLog(join(root, "host.log"))

{
  const raw = { threadId: "thread-1", header: "Bearer sk-live-0123456789abcdef", config: { api_key: "fixture-structured-key", refreshToken: "fixture-refresh", headers: { Authorization: "Basic fixture-private", Cookie: "fixture-cookie" } }, token_count: 120, model: "fixture-model" }
  retainUnknown("codex", "future/notification", "unknown", raw)
  retainUnknown("codex", "future/notification", "unknown", raw)
  retainUnknown("codex", "item/commandExecution/invalid", "unreadable", { item: { type: "commandExecution" } })
  retainUnknown("claude", "stream_event/unknown", "unknown")
  // Grok 1.0.44's `_x.ai/mcp/servers_updated` carries each MCP server's environment and headers.
  retainUnknown("grok", "_x.ai/mcp/servers_updated", "unknown", { mcpServers: [{ name: "axiom", env: [{ name: "AXIOM_TOKEN", value: "xaat-fixture-secret" }], headers: [{ name: "X-Api-Key", value: "fixture-header" }] }, { name: "local", env: { DB_URL: "postgres://user:pw@host/db", MAX_TOKENS: "4096" }, config: { AXIOM_TOKEN: "fixture-bare", dbPassword: "fixture-pw", max_tokens: 4096 } }] })
  await flushUnknown()
  await log.flush()

  const kept = (await readFile(nativeUnknownPath()!, "utf8")).trim().split("\n").map((line) => z.json().parse(JSON.parse(line)))
  const LineSchema = z.object({ harness: z.string(), kind: z.string(), reason: z.string(), record: z.json() })
  const lines = kept.map((line) => LineSchema.parse(line))
  assert.deepEqual(lines.map((line) => [line.harness, line.kind, line.reason]), [
    ["codex", "future/notification", "unknown"],
    ["codex", "item/commandExecution/invalid", "unreadable"],
    ["grok", "_x.ai/mcp/servers_updated", "unknown"],
  ], "the first record of each kind is kept; a repeat is counted, and a kind without a record is only counted")
  assert.deepEqual(lines[0]!.record, { threadId: "thread-1", header: "Bearer …", config: { api_key: "[redacted]", refreshToken: "[redacted]", headers: { Authorization: "[redacted]", Cookie: "[redacted]" } }, token_count: 120, model: "fixture-model" }, "known structured credential fields are redacted without dropping model/token-count evidence")
  assert.deepEqual(lines[2]!.record, { mcpServers: [
    { name: "axiom", env: [{ name: "AXIOM_TOKEN", value: "[redacted]" }], headers: [{ name: "X-Api-Key", value: "[redacted]" }] },
    { name: "local", env: { DB_URL: "[redacted]", MAX_TOKENS: "[redacted]" }, config: { AXIOM_TOKEN: "[redacted]", dbPassword: "[redacted]", max_tokens: 4096 } },
  ] }, "MCP server environments and headers keep their names but no values, in either shape")
  assert.deepEqual(unknownKinds().map((kind) => [kind.kind, kind.count]), [
    ["future/notification", 2],
    ["item/commandExecution/invalid", 1],
    ["stream_event/unknown", 1],
    ["_x.ai/mcp/servers_updated", 1],
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
  const capture = nativeCapture("codex", "conversation/1", () => ({ threadId, diagnostic: "Bearer sk-live-0123456789abcdef", env: { ANTHROPIC_API_KEY: "fixture-env-key", XAI_API_KEY: "fixture-xai-key" }, credentials: { accessToken: "fixture-access" } }))
  assert.ok(capture)
  assert.match(capture.path, /native-captures\/codex-conversation_1-.+\.jsonl$/, "one file per conversation, beside the host log")
  threadId = "thread-1"
  const messages: JsonObject[] = [
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "a", delta: "token=abc123 stays private" } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, items: [] } } },
  ]
  capture.record(messages[0]!)
  capture.prompted()
  for (const message of messages.slice(1)) capture.record(message)
  await capture.flush()
  delete process.env[NATIVE_CAPTURE_ENV]

  const recording = await readRecording(capture.path)
  assert.equal(recording.harness, "codex")
  assert.deepEqual(recording.session, { threadId: "thread-1", diagnostic: "Bearer …", env: { ANTHROPIC_API_KEY: "[redacted]", XAI_API_KEY: "[redacted]" }, credentials: "[redacted]" }, "the first-message header preserves provenance while scrubbing secrets too")
  assert.equal(recording.messages.length, 3)
  assert.deepEqual(recording.prompts, [1], "a prompt Mako sent is kept where it fell, before the message that followed it")
  assert.match(JSON.stringify(recording.messages[1]), /token=… stays private/, "captured content is scrubbed of token values")
  const steps = decodeSession(decoderFor("codex"), recording.session, recording.messages)
  assert.deepEqual(steps.map((step) => step.kind), ["turn/started", "item/agentMessage/delta", "turn/completed"])
  assert.ok(steps[1]!.decoded.length, "a captured session decodes as it arrived")
  console.log("PASS: an opt-in capture records a conversation, where its prompts were sent, and replays through its decoder")
}

{
  process.env[NATIVE_CAPTURE_ENV] = "codex"
  const capture = nativeCapture("codex", "unicode-byte-limit", () => ({}))!
  // 12 MiB of UTF-8 data, but only 6 MiB of JavaScript code units. The old
  // accounting silently accepted well over the advertised 64 MiB byte cap.
  const message = { text: "é".repeat(6 * 1024 * 1024) }
  for (let index = 0; index < 7; index++) capture.record(message)
  await capture.flush()
  delete process.env[NATIVE_CAPTURE_ENV]
  const size = (await stat(capture.path)).size
  assert.ok(size <= 64 * 1024 * 1024 + 1024, "the on-disk byte limit allows only a small explicit loss footer")
  const file = await open(capture.path, "r")
  try {
    const tail = Buffer.alloc(1024)
    await file.read(tail, 0, tail.length, size - tail.length)
    const footer = JSON.parse(tail.toString("utf8").trim().split("\n").at(-1)!)
    assert.equal(footer.truncated, true)
    assert.ok(footer.bytes > 48 * 1024 * 1024 && footer.bytes < 64 * 1024 * 1024)
    assert.equal(size, footer.bytes + Buffer.byteLength(JSON.stringify(footer) + "\n"))
  } finally { await file.close() }
  console.log("PASS: Unicode source capture uses actual UTF-8 bytes and records explicit truncation once")
}

for (const { provider } of providerHost.harnesses.list()) assert.equal(decoderFor(provider).provider, provider)
assert.throws(() => decoderFor("nope"), /No harness named nope\. Decoders: .*claude.*opencode/)
await rm(root, { recursive: true, force: true })
console.log("PASS: native records")
