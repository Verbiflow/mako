import assert from "node:assert/strict"
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import { installHostLog } from "@mako/host/base/host-log"
import { nativeStream } from "@mako/host/harnesses/native-stream"
import { CodexRolloutTail } from "@mako/host/harnesses/codex/rollout-tail"
import { credentialFreeJson, nativeStreamJson } from "@mako/host/base/native-diagnostic-json"
import { STREAMS_ROOT, streamOwner, streamsOf, streamsRoot } from "@mako/sessions/record-streams"
import { readStreamOriginal } from "@mako/sessions/record-original"
import { NativeUnknown, retainUnknown } from "@mako/host/base/native-unknown"
import type { RecordRef } from "@mako/sessions/entries"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { decoderFor, decodeSession, FIXTURE_ROOT, readRecording } from "./native-decoding.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

/**
 * The two records a decoder leaves for whoever adds the next translation:
 * unknown native records kept beside the host log, and the stream of every
 * launch, which replays through the decoder as it arrived.
 */

const root = await mkdtemp(join(tmpdir(), "mako-native-records-"))
const log = installHostLog(join(root, "host.log"))
const streams = streamsRoot(join(root, "records"))

{
  retainUnknown("codex", "before/following", "unknown", { lost: true })
  const unknown = new NativeUnknown(root)
  const stop = unknown.follow()
  retainUnknown("codex", "while/following", "unknown")
  stop()
  retainUnknown("codex", "after/following", "unknown")
  assert.deepEqual(unknown.kinds().map((kind) => kind.kind), ["while/following"], "a host keeps only what is reported while it follows")
}

const unknown = new NativeUnknown(root)
unknown.follow()

{
  const raw = { threadId: "thread-1", header: "Bearer sk-live-0123456789abcdef", config: { api_key: "fixture-structured-key", refreshToken: "fixture-refresh", headers: { Authorization: "Basic fixture-private", Cookie: "fixture-cookie" } }, token_count: 120, model: "fixture-model" }
  retainUnknown("codex", "future/notification", "unknown", raw)
  retainUnknown("codex", "future/notification", "unknown", raw)
  retainUnknown("codex", "item/commandExecution/invalid", "unreadable", { item: { type: "commandExecution" } })
  retainUnknown("claude", "stream_event/unknown", "unknown")
  // Grok 1.0.44's `_x.ai/mcp/servers_updated` carries each MCP server's environment and headers.
  retainUnknown("grok", "_x.ai/mcp/servers_updated", "unknown", { mcpServers: [{ name: "axiom", env: [{ name: "AXIOM_TOKEN", value: "xaat-fixture-secret" }], headers: [{ name: "X-Api-Key", value: "fixture-header" }] }, { name: "local", env: { DB_URL: "postgres://user:pw@host/db", MAX_TOKENS: "4096" }, config: { AXIOM_TOKEN: "fixture-bare", dbPassword: "fixture-pw", max_tokens: 4096 } }] })
  await unknown.flush()
  await log.flush()

  const kept = (await readFile(unknown.path, "utf8")).trim().split("\n").map((line) => z.json().parse(JSON.parse(line)))
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
  assert.deepEqual(unknown.kinds().map((kind) => [kind.kind, kind.count]), [
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
  // Each version a launch reported counts apart, with the stream line its newest came in.
  const frame: RecordRef = { file: "mako-streams:grok/s@launch.jsonl", ranges: [[120, 260]] }
  retainUnknown("grok", "_x.ai/session/checkpoint", "unknown", { method: "_x.ai/session/checkpoint" }, 1, { version: "1.0.62", frame })
  retainUnknown("grok", "_x.ai/session/checkpoint", "unknown", undefined, 1, { version: "1.0.62" })
  retainUnknown("grok", "_x.ai/session/checkpoint", "unknown", { method: "_x.ai/session/checkpoint" }, 1, { version: "1.0.63", frame })
  await unknown.flush()
  const checkpoint = unknown.kinds().filter((kind) => kind.kind === "_x.ai/session/checkpoint").map((kind) => [kind.version, kind.count, Boolean(kind.newest.frame)])
  assert.deepEqual(checkpoint.sort(), [["1.0.62", 2, false], ["1.0.63", 1, true]], "counted by version; the newest names its stream line when it has one")
  const lines = (await readFile(unknown.path, "utf8")).trim().split("\n").map((line) => z.object({ kind: z.string(), version: z.string().optional(), frame: z.json().optional() }).parse(JSON.parse(line)))
    .filter((line) => line.kind === "_x.ai/session/checkpoint")
  assert.deepEqual(lines.map((line) => [line.version, line.frame]), [["1.0.62", frame], ["1.0.63", frame]], "the first of each version is kept with its version and line")
  console.log("PASS: unread live records count by the version each launch reported, and keep the line they came in")
}

{
  assert.equal(nativeStream("codex", "conversation", () => ({}), undefined, () => "thread-1"), null, "a driver given nowhere to keep streams keeps none")

  let threadId: string | null = null
  const stream = nativeStream("codex", "conversation/1", () => ({ threadId, diagnostic: "Bearer sk-live-0123456789abcdef", env: { ANTHROPIC_API_KEY: "fixture-env-key", XAI_API_KEY: "fixture-xai-key" }, credentials: { accessToken: "fixture-access" } }), streams, () => threadId)
  assert.ok(stream)
  const messages: JsonObject[] = [
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "a", delta: "token=abc123 and Bearer sk-live-0123456789abcdef stay as the harness sent them" } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, items: [] } } },
  ]
  const refs = [stream.record(messages[0]!)?.frame]
  await stream.flush()
  const unbound = stream.path
  assert.ok(unbound && streamOwner(streams, unbound) === null, "a launch writes before the harness names its session")
  threadId = "thread-1"
  const prompted = stream.prompted({ text: "<context>…</context>\n\nCount the lines", shown: "Count the lines" })?.frame
  refs.push(stream.record(messages[1]!)?.frame)
  const steered = stream.steered("Only the first file")?.frame
  refs.push(stream.record(messages[2]!)?.frame)
  const opened = stream.prompted()?.frame
  await stream.flush()
  assert.deepEqual(streamOwner(streams, stream.path!), { harness: "codex", nativeId: "thread-1" }, "then the file takes the session's id")
  assert.deepEqual(await streamsOf(streams, "codex", "thread-1"), [stream.path], "one file per launch, found by its session")
  assert.equal(await stat(unbound).then(() => true, () => false), false, "the unbound file was renamed, not copied")

  const recording = await readRecording(stream.path!)
  assert.equal(recording.harness, "codex")
  assert.deepEqual(recording.session, { threadId: null, diagnostic: "Bearer sk-live-0123456789abcdef", env: { ANTHROPIC_API_KEY: "[redacted]", XAI_API_KEY: "[redacted]" }, credentials: "[redacted]" }, "fields that name credentials are redacted; nothing else is changed")
  assert.deepEqual(recording.messages, messages, "every frame is kept whole, before and after the session was named")
  assert.deepEqual((recording.prompts ?? []).map(({ frame: _frame, ...prompt }) => prompt), [
    { at: 1, text: "Count the lines" },
    { at: 2, text: "Only the first file", steered: true },
    { at: 3 },
  ], "a prompt Mako sent and a message it steered in keep the words Mako showed where they fell; a turn the harness opened has none")
  // Each frame's reference is handed out as it is queued, and reads back as that line whole, before and after the file took its session's name.
  const sent = [prompted, steered, opened]
  assert.deepEqual((recording.prompts ?? []).map((prompt) => prompt.frame), sent.map((ref) => ref?.ranges?.[0]), "a prompt's place is the one its line was given")
  for (const [index, ref] of refs.entries()) {
    assert.ok(ref, "a recorded frame names its line")
    const [part] = await readStreamOriginal(streams, ref)
    assert.equal(part?.kind, "range", `frame ${index} reads back`)
    assert.deepEqual(part?.kind === "range" && JSON.parse(part.text).message, messages[index], `frame ${index} is its message whole`)
  }
  assert.equal(refs[0]!.file, `${STREAMS_ROOT}:codex/${basename(unbound)}`, "a frame written before the session was named names the launch's file")
  const [shownLine] = await readStreamOriginal(streams, prompted!)
  const { at: _at, ...line } = shownLine?.kind === "range" ? z.record(z.string(), z.json()).parse(JSON.parse(shownLine.text)) : {}
  assert.deepEqual(line, { prompted: true, text: "<context>…</context>\n\nCount the lines", shown: "Count the lines" }, "the prompt's line keeps what was sent and what Mako showed")
  const steps = decodeSession(decoderFor("codex"), recording.session, recording.messages)
  assert.deepEqual(steps.map((step) => step.kind), ["turn/started", "item/agentMessage/delta", "turn/completed"])
  assert.ok(steps[1]!.decoded.length, "a stream decodes as it arrived")
  console.log("PASS: a stream keeps every frame whole, takes its session's id once the harness names it, and replays through its decoder")
}

{
  // A launch that ended says so last; what follows is appended only to the file still there, and a pruned file is never made again.
  const stream = nativeStream("grok", "ending", () => ({}), streams, () => "ending-1")!
  stream.ended()
  await stream.flush()
  assert.equal(stream.path, null, "a launch that wrote nothing has no file to finish")
  stream.record({ method: "session/update" })
  stream.closed()
  stream.ended()
  stream.ended()
  await stream.flush()
  const lines = (await readFile(stream.path!, "utf8")).trim().split("\n").map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))
  assert.deepEqual(lines.slice(-2).map(({ at: _at, ...rest }) => rest), [{ closed: true }, { ended: true }], "the ended line comes once, last")
  assert.ok(z.object({ writer: z.object({ id: z.string(), pid: z.number() }) }).safeParse(lines[0]).success, "the header names its writer")
  stream.record({ method: "late" })
  await stream.flush()
  assert.match(await readFile(stream.path!, "utf8"), /"late"/, "a line after the end is appended while the file is there")
  await rm(stream.path!)
  stream.record({ method: "after-prune" })
  await stream.flush()
  assert.equal(await stat(stream.path!).then(() => true, () => false), false, "a pruned file is not made again by a late line")
  console.log("PASS: a stream ends with one ended line, and a late line never brings back a pruned file")
}

{
  let id = "first"
  const stream = nativeStream("claude", "forked", () => ({}), streams, () => id)!
  stream.record({ type: "system", subtype: "init", session_id: "first" })
  await stream.flush()
  const first = stream.path
  id = "second"
  stream.record({ type: "system", subtype: "init", session_id: "second" })
  await stream.flush()
  assert.notEqual(stream.path, first)
  assert.deepEqual((await readRecording(first!)).messages, [{ type: "system", subtype: "init", session_id: "first" }])
  assert.deepEqual((await readRecording(stream.path!)).messages, [{ type: "system", subtype: "init", session_id: "second" }], "a launch that changes session starts a file of the new one, with its own header")

  interface Loop { type: string; self?: Loop }
  const circular: Loop = { type: "loop" }
  circular.self = circular
  stream.record(circular)
  stream.record(() => "a function JSON writes nothing for")
  stream.record({ after: true })
  await stream.flush()
  const lines = (await readFile(stream.path!, "utf8")).trim().split("\n").map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))
  assert.match(String(lines.at(-3)?.unrecordable), /circular/i, "a frame JSON can't hold leaves a line saying so, and the driver goes on")
  assert.equal(lines.at(-2)?.unrecordable, "undefined")
  assert.deepEqual(lines.at(-1)?.message, { after: true })

  stream.closed()
  stream.record({ type: "system", subtype: "status", status: "shutting down" })
  await stream.flush()
  const closed = await readRecording(stream.path!)
  assert.deepEqual(closed.messages.at(-1), { type: "system", subtype: "status", status: "shutting down" }, "what the harness says as Mako closes it is kept")
  assert.equal(closed.closed, closed.messages.length - 1, "and marked as reaching no view, so a replay stops before it")
  console.log("PASS: a launch that changes session starts a new file, a frame JSON can't hold is marked in place, and a close is marked where it fell")
}

{
  // Codex's rollout is the session's own record: its stream names the bytes the driver read, and a replay reads them back.
  const rollout = join(root, "rollout.jsonl")
  const record = (type: string, text: string) => `${JSON.stringify({ timestamp: "2026-10-14T00:00:00.000Z", type, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })}\n`
  await writeFile(rollout, record("session_meta", "before the launch"))
  const tail = new CodexRolloutTail(rollout)
  await appendFile(rollout, `${record("response_item", "first")}not json\n${record("response_item", "second")}[1]\n${record("response_item", "third").slice(0, 20)}`)
  const reads = tail.read()
  await appendFile(rollout, record("response_item", "third").slice(20))
  reads.push(...tail.read())
  const stream = nativeStream("codex", "rollout", () => ({}), streams, () => "thread-rollout")!
  for (const read of [reads.slice(0, 2), reads.slice(2)]) stream.record({ records: { rollout, from: read[0]!.from, to: read.at(-1)!.to } })
  await stream.flush()
  const replayed = (await readRecording(stream.path!)).messages.flatMap((message) => z.object({ records: z.array(z.json()) }).parse(message).records)
  assert.deepEqual(replayed, z.json().parse(reads), "a range reads back as the records the tail took, the torn and foreign lines skipped alike")
  assert.equal(reads.length, 3)
  assert.ok((await stat(stream.path!)).size < 600, "the stream holds where the records are, not the records")
  console.log("PASS: a Codex stream names the rollout bytes it read, and replays the records they hold")
}

{
  const stream = nativeStream("codex", "beyond-the-old-cap", () => ({}), streams, () => "big")!
  // 84 MiB of UTF-8, past the 64 MiB the opt-in capture stopped at.
  const message = { text: "é".repeat(6 * 1024 * 1024) }
  for (let index = 0; index < 7; index++) stream.record(message)
  await stream.flush()
  const size = (await stat(stream.path!)).size
  const line = Buffer.byteLength(JSON.stringify(message))
  assert.ok(size > 7 * line, `every frame is on disk whole: ${size} bytes for 7 of ${line}`)
  assert.equal((await readRecording(stream.path!)).messages.length, 7)
  console.log("PASS: a stream has no size limit")
}

{
  // Every frame of every recorded session: the fast path writes exactly what the replacer would.
  const files = (await readdir(FIXTURE_ROOT, { recursive: true })).filter((name) => name.endsWith(".json") || name.endsWith("capture.jsonl"))
  let frames = 0
  let named = 0
  for (const name of files) {
    const recording = await readRecording(join(FIXTURE_ROOT, name)).catch(() => null)
    for (const message of recording?.messages ?? []) {
      frames++
      const fast = nativeStreamJson(message)
      if (fast !== JSON.stringify(message)) named++
      assert.equal(fast, credentialFreeJson(message), `${name}: frame ${frames} as the replacer writes it`)
    }
  }
  const tricky: JsonObject[] = [
    { API_KEY: "a", "x-api-key": "b", "Private-Key": "c", secret_access_key: "d", pass_word: "e", "to\u212Aen": "f", Set_Cookie: "g", HTTP_HEADERS: { a: "h" }, Env: [{ name: "N", value: "i" }] },
    { input_tokens: 4, tokens: 5, max_tokens: 6, tokenizer: "kept", environmentName: "kept", headersSent: true },
    { text: "\"apiKey\": not a key", nested: [{ deep: { refreshToken: "j" } }] },
  ]
  for (const message of tricky) assert.equal(nativeStreamJson(message), credentialFreeJson(message), JSON.stringify(message))
  assert.doesNotMatch(nativeStreamJson(tricky[0])!, /:"[a-j]"/, "every credential field in any spelling is redacted")
  assert.equal(nativeStreamJson(tricky[1]), JSON.stringify(tricky[1]), "token counts and look-alike names are kept")
  console.log(`PASS: the fast path writes what the replacer writes, for ${frames} recorded frames (${named} naming a credential field) across ${files.length} recordings`)
}

for (const { provider } of providerHost.harnesses.list()) assert.equal(decoderFor(provider).provider, provider)
assert.throws(() => decoderFor("nope"), /No harness named nope\. Decoders: .*claude.*opencode/)
await rm(root, { recursive: true, force: true })
console.log("PASS: native records")
