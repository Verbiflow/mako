import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { parseRootContext, readCursorSdkContext } from "@mako/sessions/cursor-sdk-index"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { CursorProvider } from "@mako/sessions"
import { compactionEvent, type Compaction } from "@mako/sessions/events"
import { cursorSdkStateRoot, cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"
import { CursorSdkClient } from "@mako/host/harnesses/cursor/sdk/client"
import { CursorDecoder } from "@mako/host/harnesses/cursor/sdk/decoder"
import { CURSOR_SDK_WIRE_VERSION, type SdkEvent, type SdkMethod, type SdkResult } from "@mako/host/harnesses/cursor/sdk/wire"
import type { CursorSdkLiveClient } from "@mako/host/harnesses/cursor/sdk/driver"
import type { CursorSdkSpawnOptions } from "@mako/host/harnesses/cursor/sdk/auth"
import type { ProviderStartOptions } from "@mako/host/harnesses/live-driver"
import { admitted } from "./fixtures/admitted-start.ts"

type Answers = { [M in SdkMethod]?: () => SdkResult<M> }

/**
 * Cursor's context meter. Each checkpoint root the SDK saves holds Cursor's
 * own reading (`token_details`: the last model call's input and output, of
 * the model's window, and an estimate by category); the child writes it as
 * a `context` event each time the open agent's root moves to a new reading,
 * and once as an agent opens. Without the model: the root parser, the
 * reader, the real child opening a fixture agent, the decoder's meter and
 * breakdown, and the driver end to end. `--live` adds a real turn of several
 * model calls through the real child, whose readings must sum to exactly
 * the turn's `inputTokens + outputTokens` (`CURSOR_API_KEY`).
 * `--live-compaction` reads five 257 KB files in one turn, about 1.3 M
 * tokens on composer-2.5, so Cursor summarizes on its server mid-turn; the
 * child's `compaction` must be the marker the saved reader draws from the
 * store it left: the same window, reading before and summary.
 *
 *   npx tsx scripts/test-cursor-context.ts [--live] [--live-compaction]
 */

const live = process.argv.includes("--live")
const liveCompaction = process.argv.includes("--live-compaction")
const SUMMARY_PROMPT = "Read big1.txt in full with your read tool, then big2.txt, big3.txt, big4.txt and big5.txt in full, one file per step, sequentially, reading every line of each (page through a file if the tool returns only part of it). After all five, reply with the first word on the last line of big5.txt."
const root = mkdtempSync(join(tmpdir(), "mako-live-test-cursor-context-"))
const stores = new NativeStores(false)
const child = resolve("packages/host/dist/harnesses/cursor/sdk/child.js")

/** A protobuf varint. */
function varint(value: number): number[] {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return bytes
}
const number = (field: number, value: number) => [...varint(field * 8), ...varint(value)]
const bytes = (field: number, data: readonly number[]) => [...varint(field * 8 + 2), ...varint(data.length), ...data]
const text = (field: number, value: string) => bytes(field, [...Buffer.from(value)])
const category = (id: string, label: string, tokens: number) => bytes(3, [...text(1, id), ...text(2, label), ...tokens ? number(3, tokens) : [], ...number(4, tokens * 3)])
/** A root as Cursor writes one: message hashes (field 1), the workspace (9) and `token_details` (5). */
function rootBlob(details?: { used: number; size: number; categories?: [string, string, number][] }): Uint8Array {
  const hash = (name: string) => [...createHash("sha256").update(name).digest()]
  const parts = [...bytes(1, hash("system")), ...bytes(1, hash("user")), ...text(9, "file:///fixture")]
  if (details) {
    const breakdown = [...number(1, details.used), ...number(2, details.size), ...(details.categories ?? []).flatMap(([id, label, tokens]) => category(id, label, tokens))]
    parts.push(...bytes(5, [...number(1, details.used), ...number(2, details.size), ...bytes(3, breakdown)]))
  }
  return new Uint8Array(parts)
}

const CATEGORIES: [string, string, number][] = [
  ["system_prompt", "System prompt", 1758], ["tools", "Tool definitions", 3164], ["summarized_conversation", "Summarized conversation", 0], ["conversation", "Conversation", 2024],
]

try {
  parsing()
  const fixture = await fixtureAgent()
  reading(fixture)
  await childOpens(fixture)
  decoding()
  await driverMeters()
  if (live) {
    const apiKey = process.env.CURSOR_API_KEY
    if (!apiKey) throw new Error("--live needs CURSOR_API_KEY")
    await liveTurn(apiKey)
  } else console.log("cursor context: pass --live for a real turn")
  if (liveCompaction) {
    const apiKey = process.env.CURSOR_API_KEY
    if (!apiKey) throw new Error("--live-compaction needs CURSOR_API_KEY")
    await liveSummary(apiKey)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

/** The root's reading, Cursor's breakdown without the categories it counted nothing in, and no reading where it has none. */
function parsing() {
  assert.deepEqual(parseRootContext(rootBlob({ used: 6946, size: 200000, categories: CATEGORIES })), {
    used: 6946,
    size: 200000,
    categories: [
      { id: "system_prompt", label: "System prompt", tokens: 1758 },
      { id: "tools", label: "Tool definitions", tokens: 3164 },
      { id: "conversation", label: "Conversation", tokens: 2024 },
    ],
  })
  assert.equal(parseRootContext(rootBlob()), undefined, "a checkpoint saved before any model call has no reading")
  assert.equal(parseRootContext(rootBlob({ used: 10, size: 0 })), undefined, "a reading against no window is none")
  assert.deepEqual(parseRootContext(rootBlob({ used: 512, size: 272000 }))?.categories, [], "a reading without a breakdown")
  assert.equal(parseRootContext(new Uint8Array([0x2a, 0x7f])), undefined, "a truncated root reads as nothing")
  console.log("cursor context: a root's token_details read as used, window and categories")
}

interface Fixture {
  stateRoot: string
  cwd: string
  agentId: string
  bare: string
}

/** Two agents the SDK's own store API wrote: one whose latest root holds a reading, one whose root holds none. */
async function fixtureAgent(): Promise<Fixture> {
  const stateRoot = join(root, "fixture", "state")
  const cwd = join(root, "fixture", "work")
  mkdirSync(cwd, { recursive: true })
  const agentId = "fixture-context-0000-4000-8000-000000000001"
  const bare = "fixture-context-0000-4000-8000-000000000002"
  const now = Date.now()
  const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot })
  try {
    for (const [id, data] of [[agentId, rootBlob({ used: 6946, size: 200000, categories: CATEGORIES })], [bare, rootBlob()]] as const) {
      const blobId = createHash("sha256").update(data).digest("hex")
      await store.agents.create({
        agent: { agentId: id, cwd, status: "idle", name: "Fixture", createdAt: now, updatedAt: now, latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId }, sdkMetadata: { blobEncryptionKey: "cd".repeat(32), initialMode: "agent" } },
      })
      await store.checkpoints.create({ agentId: id, blobId, data })
    }
  } finally {
    await store.dispose()
  }
  return { stateRoot, cwd, agentId, bare }
}

function reading(fixture: Fixture) {
  assert.deepEqual(readCursorSdkContext(stores, fixture.stateRoot, fixture.agentId), parseRootContext(rootBlob({ used: 6946, size: 200000, categories: CATEGORIES })))
  assert.equal(readCursorSdkContext(stores, fixture.stateRoot, fixture.bare), undefined)
  assert.equal(readCursorSdkContext(stores, fixture.stateRoot, "fixture-absent"), undefined)
  assert.equal(readCursorSdkContext(stores, join(root, "nowhere"), fixture.agentId), undefined)
  console.log("cursor context: the agent's latest root is read through index.db")
}

/** The real child, opening each fixture agent: the reading its latest root holds, as one turn-less `context` event. */
async function childOpens(fixture: Fixture) {
  assert.ok(existsSync(child), "build the host first (npm run build:electron)")
  const open = async (agentId: string) => {
    const events: Extract<SdkEvent, { event: "context" }>[] = []
    const client = new CursorSdkClient({
      owner: randomUUID(),
      cwd: fixture.cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CURSOR_API_KEY: "key_fixture_0123456789abcdef" },
      entry: child,
      execPath: process.execPath,
      onEvent: (event) => {
        if (event.event === "context") events.push(event)
      },
    })
    try {
      await client.hello()
      await client.request("open", { cwd: fixture.cwd, stateRoot: fixture.stateRoot, strictStores: false, agentId, create: false })
    } finally {
      await client.close(5_000).catch(() => client.kill())
    }
    return events
  }
  assert.deepEqual(await open(fixture.agentId), [{
    event: "context",
    used: 6946,
    size: 200000,
    categories: [
      { id: "system_prompt", label: "System prompt", tokens: 1758 },
      { id: "tools", label: "Tool definitions", tokens: 3164 },
      { id: "conversation", label: "Conversation", tokens: 2024 },
    ],
  }], "an opening agent's meter starts from its latest checkpoint, before any turn")
  assert.deepEqual(await open(fixture.bare), [], "a root with no reading writes none")
  console.log("cursor context: the real child reports the opened agent's last reading, and nothing for a root without one")
}

/** The meter shows Cursor's reading; the same reading again changes nothing; a summary leaves it waiting. */
function decoding() {
  const decoder = new CursorDecoder({ models: [], state: { settings: undefined } })
  const reading = (used: number, categories?: { id: string; label: string; tokens: number }[]) =>
    decoder.context({ event: "context", turn: "turn-1", used, size: 200000, ...categories && { categories } })
  assert.deepEqual(reading(6946, [{ id: "tools", label: "Tool definitions", tokens: 6946 }]), [{ kind: "state", patch: { usage: { used: 6946, size: 200000 } } }])
  assert.deepEqual(decoder.breakdown, { used: 6946, size: 200000, categories: [{ name: "Tool definitions", tokens: 6946, kind: "used" }], items: [] })
  assert.deepEqual(reading(6946, [{ id: "tools", label: "Tool definitions", tokens: 6946 }]), [], "the same reading again moves nothing")
  // Read with no turn open: an opening agent's, or a stopped run's last.
  assert.equal(decoder.open, false)
  decoder.startTurn("turn-1")
  const summary = decoder.decode({ event: "delta", turn: "turn-1", delta: { type: "summary-started" } })
  assert.deepEqual(summary.filter((item) => item.kind === "state"), [{ kind: "state", patch: { usage: { compactedFrom: 6946, size: 200000 } } }], "a summary Cursor reports leaves no fill until it measures again")
  assert.equal(decoder.breakdown, undefined, "nor an itemized context")
  assert.deepEqual(reading(2100), [{ kind: "state", patch: { usage: { used: 2100, size: 200000 } } }])
  assert.equal(decoder.breakdown, undefined, "a reading without categories itemizes nothing")
  // Reopened after a summary a root since has measured: the marker an earlier child drew is completed, none drawn anew.
  const reopened = new CursorDecoder({ models: [], state: { settings: undefined } })
  assert.deepEqual(reopened.archived({ event: "compaction", window: "window-1", drawn: true, tokensBefore: 190_997, tokensAfter: 23_418 }), [
    { kind: "compacted", compaction: { tokensBefore: 190_997, tokensAfter: 23_418 }, source: "window-1", completes: true },
  ], "a reopened agent's measured summary completes the marker drawn before")
  assert.deepEqual(reopened.context({ event: "context", used: 23_418, size: 200_000 }), [{ kind: "state", patch: { usage: { used: 23_418, size: 200_000 } } }], "and its reading is the meter's, with nothing left to complete")
  console.log("cursor context: the decoder's meter and breakdown follow each reading")
}

/** The driver's session takes the child's readings as its usage and answers the meter's breakdown from the latest. */
async function driverMeters() {
  const { CursorSdkAuth } = await import("@mako/host/harnesses/cursor/sdk/auth")
  const { CursorCredentialStore } = await import("@mako/host/harnesses/cursor/sdk/credentials")
  const { memorySecrets } = await import("@mako/host/base/secrets")
  const { createCursorSdkDriver } = await import("@mako/host/harnesses/cursor/sdk/driver")
  let spawned: CursorSdkSpawnOptions | undefined
  const client: CursorSdkLiveClient = {
    alive: true,
    exited: new Promise(() => {}),
    hello: async () => ({ wire: CURSOR_SDK_WIRE_VERSION, sdkVersion: "fixture", node: process.version }),
    request: async (method) => {
      const answers: Answers = {
        me: () => ({ email: "fixture@example.test", apiKeyName: "fixture", createdAt: "2026-10-17" }),
        open: () => {
          spawned?.onEvent({ event: "context", used: 41_250, size: 272_000, categories: [{ id: "conversation", label: "Conversation", tokens: 41_250 }] })
          return { agentId: "context-binding", model: { id: "fixture-model" } }
        },
      }
      const respond = answers[method]
      if (!respond) throw new Error(`Unexpected fixture method: ${method}`)
      return respond()
    },
    close: async () => {},
    kill() {},
  }
  const auth = new CursorSdkAuth({
    env: async () => ({ CURSOR_API_KEY: "key_fixture_0123456789abcdef" }),
    openUrl: async () => { throw new Error("Fixture must not sign in") },
    credentials: new CursorCredentialStore(memorySecrets({ durable: false })),
    cliKey: async () => null,
    client: () => client,
  })
  const driver = createCursorSdkDriver({
    stores,
    auth,
    stateRoot: () => join(root, "driver"),
    home: root,
    client: (options) => {
      spawned = options
      return client
    },
    models: async () => [{ id: "fixture-model", displayName: "Fixture" }],
  })
  assert.equal(driver.contextBreakdown.kind, "itemized")
  const emitted: Parameters<ProviderStartOptions["emit"]>[0][] = []
  await driver.start(root, admitted("cursor", { conversationId: "context-binding", resume: "context-binding", emit(event) { emitted.push(event) } }, { env: { CURSOR_API_KEY: "key_fixture_0123456789abcdef" } }))
  assert.ok(JSON.stringify(emitted).includes(`"usage":{"used":41250,"size":272000}`), "the session's usage is the child's reading")
  assert.deepEqual(driver.contextBreakdown.kind === "itemized" && await driver.contextBreakdown.read("context-binding"), {
    used: 41_250, size: 272_000, categories: [{ name: "Conversation", tokens: 41_250, kind: "used" }], items: [],
  })
  await driver.close("context-binding")
  console.log("cursor context: the driver's session shows the reading and itemizes it")
}

/** Several model calls in one turn: one reading each, summing to exactly what the turn's usage reports. */
async function liveTurn(apiKey: string) {
  const cwd = join(root, "live", "work")
  mkdirSync(cwd, { recursive: true })
  for (const [n, word] of ["amber", "cobalt", "jade"].entries()) writeFileSync(join(cwd, `f${n + 1}.txt`), `file ${n + 1} holds the word ${word}\n`)
  const readings: Extract<SdkEvent, { event: "context" }>[] = []
  let usage: { inputTokens: number; outputTokens: number } | undefined
  let ended = () => {}
  const done = new Promise<void>((settle) => { ended = settle })
  const capture = process.env.MAKO_CURSOR_CONTEXT_CAPTURE
  const client = new CursorSdkClient({
    owner: randomUUID(),
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CURSOR_API_KEY: apiKey },
    entry: child,
    execPath: process.execPath,
    onEvent: (event) => {
      if (capture && event.event !== "log") appendFileSync(capture, `${JSON.stringify({ message: event })}\n`)
      if (event.event === "context") readings.push(event)
      if (event.event === "message" && event.message.type === "usage") usage = event.message.usage
      if (event.event === "result") ended()
    },
  })
  try {
    await client.hello()
    const { models } = await client.request("models", undefined)
    const model = { id: (models.find((candidate) => /composer/i.test(candidate.id)) ?? models[0]!).id }
    await client.request("open", { cwd, stateRoot: join(root, "live", "state"), strictStores: false, agentId: randomUUID(), create: true, name: "Context", model })
    const turn = randomUUID()
    await client.request("send", { turn, text: "Read f1.txt, then f2.txt, then f3.txt, one read per step, sequentially. Then reply with the three words.", model })
    await done
    assert.ok(usage, "the turn reported its usage")
    assert.ok(readings.length >= 2, `a reading after each model call: ${readings.map((entry) => entry.used).join(", ")}`)
    assert.ok(readings.every((entry) => entry.turn === turn && entry.size > 0))
    const sum = readings.reduce((total, entry) => total + entry.used, 0)
    assert.equal(sum, usage.inputTokens + usage.outputTokens, "each reading is one call's input and output: together, the turn's")
    console.log(`cursor context: live, ${readings.length} readings (${readings.map((entry) => entry.used).join(", ")}) sum to the turn's input and output, ${sum}`)
  } finally {
    await client.close(10_000).catch(() => client.kill())
  }
}

/** A turn that fills composer-2.5's window: the summary Cursor makes is marked live as the saved reader marks it. */
async function liveSummary(apiKey: string) {
  const cwd = join(root, "summary", "work")
  // The user root the provider below reads, as a host hands its own.
  const userRoot = join(root, "summary", "mako")
  const stateRoot = cursorSdkStateRoot(userRoot)
  mkdirSync(cwd, { recursive: true })
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu amber cobalt jade onyx pearl ruby slate topaz umber violet walnut maple cedar birch aspen willow spruce larch hazel rowan elder yew".split(" ")
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let file = 1; file <= 5; file++)
    writeFileSync(join(cwd, `big${file}.txt`), Array.from({ length: 1400 }, (_, line) => `${file}.${line + 1} ${Array.from({ length: 22 }, () => `${words[Math.floor(next() * words.length)]}${Math.floor(next() * 100)}`).join(" ")}`).join("\n") + "\n")
  const compactions: Extract<SdkEvent, { event: "compaction" }>[] = []
  const frames: SdkEvent[] = []
  let ended = () => {}
  const done = new Promise<void>((settle) => { ended = settle })
  const agentId = randomUUID()
  const client = new CursorSdkClient({
    owner: randomUUID(),
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CURSOR_API_KEY: apiKey },
    entry: child,
    execPath: process.execPath,
    onEvent: (event) => {
      frames.push(event)
      if (event.event === "compaction") compactions.push(event)
      if (event.event === "result") ended()
    },
  })
  try {
    await client.hello()
    const { models } = await client.request("models", undefined)
    const model = { id: (models.find((candidate) => /composer/i.test(candidate.id)) ?? models[0]!).id }
    await client.request("open", { cwd, stateRoot, strictStores: false, agentId, create: true, name: "Summary", model })
    await client.request("send", { turn: randomUUID(), model, text: SUMMARY_PROMPT })
    await done
  } finally {
    await client.close(10_000).catch(() => client.kill())
  }
  // `MAKO_CURSOR_CONTEXT_KEEP=<folder>` keeps the frames as a decode capture and the state root, for `npm run decode -- --compare`.
  const keep = process.env.MAKO_CURSOR_CONTEXT_KEEP
  if (keep) {
    mkdirSync(keep, { recursive: true })
    writeFileSync(join(keep, "capture.jsonl"), [{ capture: 1, harness: "cursor", session: {}, native: { version: "1.0.31", origin: "captured" } }, { prompted: true, text: SUMMARY_PROMPT }, ...frames.filter((frame) => frame.event !== "log").map((message) => ({ message }))].map((line) => JSON.stringify(line)).join("\n") + "\n")
    cpSync(stateRoot, join(keep, "home", ".mako", "cursor-sdk"), { recursive: true })
    writeFileSync(join(keep, "agent"), agentId)
  }
  assert.ok(compactions.length, "the turn filled the window and Cursor summarized it")
  const thread = await new CursorProvider(stores, root, userRoot).read(cursorSdkStorePath(stateRoot, agentId))
  const saved = (thread?.entries ?? []).flatMap((entry) => entry.type === "event" && entry.source?.record ? [entry] : [])
  // The live marker as it ends: the decoder's last statement of each window's compaction, completed by the run's next reading.
  const decoder = new CursorDecoder({ models: [], state: { settings: undefined } })
  const final = new Map<string, Compaction>()
  for (const frame of frames) {
    if (frame.event === "message" || frame.event === "delta") {
      if (!decoder.open) decoder.startTurn(frame.turn)
      continue
    }
    const decoded = frame.event === "compaction" ? decoder.archived(frame) : frame.event === "context" ? decoder.context(frame) : []
    for (const item of decoded) if (item.kind === "compacted" && item.source && item.compaction) final.set(item.source, item.compaction)
  }
  for (const compaction of compactions) {
    const marker = saved.find((entry) => entry.source?.record === compaction.window)
    assert.ok(marker, `the saved history marks window ${compaction.window}`)
    const live = compactionEvent(final.get(compaction.window))
    assert.deepEqual([marker.label, marker.detail, marker.body], [live.label, live.detail, live.body], "live and saved say the same of it")
  }
  // A summary before the run's last step has no reading after it in the run: both sides leave what it left unsaid.
  console.log(`cursor context: live, Cursor summarized ${compactions.length} time(s) and the saved history marks each as the child's marker ends (${[...final.values()].map((entry) => `${entry.tokensBefore} → ${entry.tokensAfter ?? "unmeasured in the run"}`).join(", ")})`)
}
