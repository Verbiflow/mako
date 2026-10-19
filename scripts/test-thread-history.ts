import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { buildTranscript, STEER_LINES, type Thread, type ThreadPage, type ThreadRef } from "@mako/sessions"
import { writeMessage } from "@mako/sessions/context-wire"
import type { Entry } from "@mako/sessions/entries"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { copiedBaseBytes, LiveJournal } from "@mako/host/conversations/live-journal"
import { registerThreadHistoryTools, threadHistoryTools, type ThreadHistoryInput } from "@mako/host/conversations/thread-history"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { ThreadStore } from "@mako/host/threads/store"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// `thread_history` on the `mako` server, called the way an agent calls it:
// over HTTP with the grant its binding was minted, while its turn runs. One
// Thread holds a conversation that switched harness (two bindings, one
// history) and a fork of it in a second tab; its first prompt references a
// live conversation whose history is still unread and a native session the
// catalog alone knows. Every action, the scoping, a 100,000-character output
// paged back exactly, and a grant that no longer runs.

const ALPHA = "test-alpha"
const BETA = "test-beta"
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-history-")))
const journals = join(root, "conversations")
const CWD = root
const started = Date.UTC(2026, 9, 16, 9, 0)
const BIG = `${Array.from({ length: 1_999 }, (_, line) => `test ${String(line).padStart(4, "0")} passed ${"·".repeat(28)}`).join("\n")}\nNEEDLE-AT-THE-END`
  .padEnd(100_000, "~")

const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await delay(5)
  }
}

// What the catalog has: the session D was captured from, and two native sessions only it knows.
const pathD = join(root, "native-d.jsonl")
const pathE = join(root, "native-e.jsonl")
const pathX = join(root, "native-x.jsonl")
writeFileSync(pathD, "")
const pageD: ThreadPage = {
  ref: { harness: ALPHA, nativeId: "native-d", path: pathD, title: "Pick the store", cwd: CWD, bytes: 10 },
  entries: [{ type: "user", id: "d-1", text: "Which store should we use?" }, { type: "text", id: "d-2", text: "D decided on SQLite with WAL." }],
  start: 0, total: 2, hasEarlier: false, translator: "build-1",
}
const rows: ThreadRef[] = [
  { harness: ALPHA, nativeId: "native-e", path: pathE, title: "Old parser notes", cwd: CWD, bytes: 20 },
  { harness: ALPHA, nativeId: "native-x", path: pathX, title: "Unrelated work", cwd: CWD, bytes: 30 },
]
const threadE: Thread = {
  ref: rows[0]!,
  entries: [
    { type: "user", id: "e-1", text: "Write down the parser notes" },
    { type: "tool", id: "e-2", name: "Read", status: "completed", input: "{\"file_path\":\"notes.md\"}", outputLength: 50_000, output: "head of the notes", contentOmitted: true },
    { type: "text", id: "e-3", text: "The tokenizer must keep trailing commas." },
    // A second turn the person sent 30 messages into while the agent worked: more than the index lists.
    { type: "user", id: "e-4", text: "Ship the parser" },
    ...Array.from({ length: 30 }, (_, n): Entry[] => [
      { type: "user", id: `e-s${n}`, steeringFor: "e-4", text: `Steer ${n}: check case ${n}\nwith a second line` },
      { type: "text", id: `e-r${n}`, text: `Checked case ${n}.` },
    ]).flat(),
  ],
}
const opened: string[] = []
const catalog = {
  list: (filter?: { harness?: string }) => rows.filter((row) => !filter?.harness || row.harness === filter.harness),
  ref: (path: string) => rows.find((row) => row.path === path),
  nativePath: ({ harness, nativeId }: { harness: string; nativeId?: string }) => rows.find((row) => row.harness === harness && row.nativeId === nativeId)?.path,
  open: async (path: string) => {
    opened.push(path)
    return path === pathE ? threadE : null
  },
  entry: async (path: string, id: string): Promise<Entry | null> =>
    path === pathE && id === "e-2" ? { type: "tool", id: "e-2", name: "Read", status: "completed", input: "{\"file_path\":\"notes.md\"}", output: `whole notes ${"n".repeat(50_000 - 12)}` } : null,
}

// The harnesses: a turn runs until the test ends, as the agent's does while it calls the tool.
const prompts: string[] = []
function driver(provider: string, owner: () => LiveConversations): ProviderLiveDriver {
  const sessions = new Map<string, LiveSessionState>()
  return {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: "fixture" },
    launchEnvironment: { kind: "unavailable", reason: "fixture" },
    nativeIdentity: { kind: "unavailable", reason: "fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "fixture", feedback: { kind: "next-message", reason: "fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "fixture" },
    turnRecovery: { kind: "manual", reason: "fixture" },
    resume: fixtureResume(),
    provider,
    available: () => true,
    start: async (cwd, options) => {
      const nativeId = options.resume ?? `native-${options.conversationId}`
      const session: LiveSessionState = {
        id: options.conversationId, nativeId, nativePath: join(root, "native", `${nativeId}.jsonl`), harness: provider, cwd,
        status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [],
      }
      sessions.set(options.conversationId, session)
      return session
    },
    prompt: async (id, text) => {
      prompts.push(text)
      owner().observe({ type: "live-session", session: { ...sessions.get(id)!, status: "running" } })
      await new Promise<void>(() => {})
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
}

let gate: { promise: Promise<void>; open: () => void } | null = null
function host(threads: ThreadStore): LiveConversations {
  let owner: LiveConversations | undefined
  const self = () => owner!
  const drivers = new Map([ALPHA, BETA].map((provider) => [provider, driver(provider, self)]))
  owner = new LiveConversations({
    appPath: root,
    root: journals,
    threads,
    driver: (provider) => drivers.get(provider),
    emit: (event) => { if (event.type === "notice") console.error("notice", event) },
    history: async (at) => {
      if (gate) await gate.promise
      return at === pathD ? pageD : null
    },
    holdHistory: async () => true,
    historyAsOf: async () => null,
    nativePath: (identity) => identity.nativeId === "native-d" ? pathD : identity.nativeId ? join(root, "native", `${identity.nativeId}.jsonl`) : undefined,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    providerIdleMs: 60_000,
    providerWarmLimit: 20,
  })
  return owner
}

const at = (minute: number) => started + minute * 60_000
const r1 = randomUUID(), r2 = randomUUID(), r3 = randomUUID(), r4 = randomUUID()
const firstPrompt = writeMessage({
  body: "Set up the parser like [Conversation 1: Pick the store] and [Conversation 2: Old parser notes]",
  items: [
    { n: 1, kind: "conversation", attrs: { ref: "thread:test-alpha:native-d", harness: ALPHA, title: "Pick the store" }, body: "Transcript bundle: /gone/transcript.md" },
    { n: 2, kind: "conversation", attrs: { ref: "thread:test-alpha:native-e", harness: ALPHA, title: "Old parser notes" }, body: "Transcript bundle: /gone/other.md" },
  ],
})
/** A's history: two turns on alpha, then a switch to beta for the third. */
const turnOne: Entry[] = [
  { type: "user", requestId: r1, provider: ALPHA, text: firstPrompt, at: at(0) },
  { type: "thinking", id: "a-think", text: "Look for the inherited marker before changing anything.", at: at(1) },
  { type: "text", id: "a-1", text: "Set up the parser.", at: at(2) },
]
const blocksA: Entry[] = [
  ...turnOne,
  { type: "user", requestId: r2, provider: ALPHA, text: "Run the tests", at: at(10) },
  { type: "tool", id: "call-test", name: "Bash", status: "completed", input: "{\"command\":\"npm test\",\"timeout\":600}", output: BIG, at: at(11) },
  { type: "text", id: "a-2", text: "All 1,999 tests pass.", at: at(12) },
  { type: "user", requestId: r3, provider: BETA, text: "Now refactor the tokenizer", at: at(20) },
  { type: "tool", id: "call-edit", name: "Edit", status: "completed", input: "{\"file_path\":\"src/tokenizer.ts\"}", details: [{ type: "diff", path: "src/tokenizer.ts", oldText: "a", newText: "b" }], at: at(21) },
  { type: "text", id: "a-3", text: "Refactored the tokenizer.", at: at(22) },
]
const context = {
  transport: "fixture", runtime: { kind: "reported", version: "1.0.0", via: "fixture" },
  account: { kind: "unavailable", reason: "fixture" }, identity: { kind: "unavailable", reason: "fixture" }, store: { kind: "unavailable", reason: "fixture" },
} as const
const request = (id: string, text: string) => ({ id, text, attachments: [], status: "completed" as const })
function journalled(snapshot: LiveSnapshot) {
  const journal = new LiveJournal(journals, snapshot.session.id)
  journal.commit(snapshot)
  journal.close()
}

async function main() {
  const threads = new ThreadStore(join(root, "threads.sqlite"), { realPath: (path) => path })
  // D: captured from its session and held, so the next host reads its history back from the session.
  const idD = randomUUID()
  const first = host(threads)
  await first.capture(idD, pathD)
  await waitFor(() => Boolean(first.snapshot(idD)?.baseSource), "D names its source once held")
  assert.equal(copiedBaseBytes(journals, idD), 0, "D's journal keeps no copy of its history")
  await first.stop()

  const idA = randomUUID()
  const idB = randomUUID()
  const [b1, b2, bB] = [randomUUID(), randomUUID(), randomUUID()]
  journalled({
    session: { id: idA, harness: BETA, nativeId: "native-a2", cwd: CWD, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [], title: "Parser work", executionContext: context },
    revision: 3, createdAt: at(0), base: null, permissions: [],
    requests: [request(r1, firstPrompt), request(r2, "Run the tests"), request(r3, "Now refactor the tokenizer")],
    blocks: blocksA,
    control: {
      activeBindingId: b2, transfers: [], actions: [], merges: [],
      bindings: [
        { id: b1, provider: ALPHA, nativeId: "native-a1", path: join(root, "native", "native-a1.jsonl"), coveredBlocks: 6, includesBase: true },
        { id: b2, provider: BETA, nativeId: "native-a2", path: join(root, "native", "native-a2.jsonl"), coveredBlocks: blocksA.length, includesBase: false },
      ],
    },
  })
  // B: a fork of A's first answer, in A's Thread; it inherited turn one and went on with its own.
  journalled({
    session: { id: idB, harness: ALPHA, nativeId: "native-b", cwd: CWD, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [], title: "Parser work — fork", executionContext: context },
    revision: 1, createdAt: at(30), permissions: [],
    base: { ref: { harness: ALPHA, nativeId: idA, path: idA, cwd: CWD }, entries: turnOne, start: 0, total: turnOne.length, hasEarlier: false },
    blocks: [
      { type: "user", requestId: r4, provider: ALPHA, text: "Try a hand-written parser instead", at: at(31) },
      { type: "text", id: "b-1", text: "Wrote a recursive-descent parser.", at: at(32) },
    ],
    requests: [request(r4, "Try a hand-written parser instead")],
    control: {
      activeBindingId: bB, transfers: [], actions: [], merges: [],
      ancestry: { kind: "fork", parentId: idA, sourceRevision: 3, point: r1, placement: "parent-thread" },
      bindings: [{ id: bB, provider: ALPHA, nativeId: "native-b", coveredBlocks: 2, includesBase: true }],
    },
  })

  gate = (() => {
    let open!: () => void
    const promise = new Promise<void>((resolve) => { open = resolve })
    return { promise, open }
  })()
  const live = host(threads)
  const placed = (id: string) => live.summaries().find((summary) => summary.session.id === id)
  await waitFor(() => Boolean(placed(idA)?.threadId && placed(idB)?.threadId), "both journals are placed")
  assert.equal(placed(idB)!.threadId, placed(idA)!.threadId, "the fork is a tab of A's Thread")

  // A's agent is running a turn: that's when it calls the tool.
  live.submit(idA, randomUUID(), "Check what we did before")
  await waitFor(() => live.snapshot(idA)?.session.status === "running", "A's turn runs")
  const binding = live.snapshot(idA)!.control!.activeBindingId

  const tools = threadHistoryTools({
    conversations: () => live.summaries(),
    snapshot: (id) => live.historySnapshot(id),
    store: () => threads,
    catalog,
  })
  const servers = await startConversationMcp(live, async () => ({ content: [] }), [(server, conversationId) => registerThreadHistoryTools(server, tools, conversationId)])
  const connect = async (bindingId: string, conversationId: string) => {
    const grant = servers.mint(bindingId, conversationId)
    const agent = new Client({ name: "history-agent", version: "1" })
    await agent.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl!), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
    return agent
  }
  const agent = await connect(binding, idA)
  const Result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal("text"), text: z.string() })) })
  const call = async (args: ThreadHistoryInput) => Result.parse(await agent.callTool({ name: "thread_history", arguments: { ...args } }))
  const text = async (args: ThreadHistoryInput) => {
    const result = await call(args)
    assert.ok(!result.isError, `${JSON.stringify(args)} answers: ${result.content[0]?.text}`)
    return result.content[0]!.text
  }

  try {
    // The server says what the tool is for, and the tool says it changes nothing.
    assert.match(agent.getInstructions() ?? "", /thread_history: this Thread's earlier turns/)
    const listed = (await agent.listTools()).tools.find((tool) => tool.name === "thread_history")
    assert.ok(listed, "the mako server lists thread_history")
    assert.deepEqual(listed.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    console.log(`tool description: ${listed.description!.length} chars, schema ${JSON.stringify(listed.inputSchema).length} chars`)

    // turns: this session's turns numbered as its transcript numbers them, one history across A's switch of harness.
    const index = await text({ action: "turns" })
    console.log(index)
    assert.match(index, /^This Thread "Parser work": 2 sessions\.$/m)
    assert.match(index, /^Session 1 · test-beta: turns 1–4; this session \(turns and refs without a session number\)$/m)
    assert.match(index, /^Session 2 · test-alpha "Parser work — fork": turns 1–2; a fork of session 1: it holds that session's first 3 entries \(address as 2:<turn>\)$/m)
    assert.match(index, /^Session 1, turns 1–4 of 4\.$/m)
    assert.match(index, /^1 2026-10-16 \d\d:00 Set up the parser like \[Conversation 1: Pick the store\] and \[Conversation 2: Old parser notes\] → "Set up the parser\."$/m)
    assert.match(index, /^2 \d\d:10 Run the tests → 1 tool \(Bash 1\) · "All 1,999 tests pass\."$/m)
    assert.match(index, /^3 \d\d:20 \[test-beta\] Now refactor the tokenizer → 1 tool \(Edit 1\) · edited tokenizer\.ts · "Refactored the tokenizer\."$/m, "a switch of harness is marked where it happened")
    assert.match(index, /^4 [\d: -]+Check what we did before → running now$/m, "the running turn is there")
    assert.match(index, /^ {2}thread:test-alpha:native-d "Pick the store" \(test-alpha\)$/m)
    assert.match(index, /^ {2}thread:test-alpha:native-e "Old parser notes" \(test-alpha\)$/m)
    const fork = await text({ action: "turns", turns: "2:1-2" })
    assert.match(fork, /^Session 2, turns 1–2 of 2\.$/m)
    assert.match(fork, /^2:2 [\d: -]+Try a hand-written parser instead → "Wrote a recursive-descent parser\."$/m)

    // read: whole entries; the big output named with its size, first lines and ref.
    const two = await text({ action: "read", turns: "2" })
    assert.match(two, /^## Turn 2 · session 1 · test-alpha/m)
    assert.match(two, /\[2\.1\] tool Bash \(completed\)\n {2}input:\n {4}command: npm test\n {4}timeout: 600/)
    assert.match(two, /output: 100,000 chars, 2,000 lines → payload ref="2\.1\/output"; it begins:\n {4}test 0000 passed/)
    assert.match(two, /\[2\.2\] reply\nAll 1,999 tests pass\./)
    const one = await text({ action: "read", turns: "1" })
    assert.match(one, /\[1\.0\] prompt\nSet up the parser like/)
    assert.match(one, /context \[1\] conversation ref="thread:test-alpha:native-d"/)
    assert.match(one, /\[1\.1\] thinking\n {2}text: Look for the inherited marker/)
    const latest = await text({ action: "read" })
    assert.match(latest, /^## Turn 4 · session 1 · test-beta[^\n]*\n\[4\.0\] prompt\nCheck what we did before$/, "this session's newest turn by default, while it runs")
    const forked = await text({ action: "read", turns: "2:2" })
    assert.match(forked, /^## Turn 2 · session 2 · test-alpha[^\n]*\n\[2:2\.0\] prompt\nTry a hand-written parser instead\n\[2:2\.1\] reply\nWrote a recursive-descent parser\.$/)
    const paged = await text({ action: "read", turns: "1-4" })
    assert.match(paged, /## Turn 1 [\s\S]*## Turn 2 [\s\S]*## Turn 3 [\s\S]*## Turn 4 /, "a range reads in order")

    // payload: the whole output back, a page at a time, exactly.
    let whole = ""
    let offset = 0
    let pages = 0
    for (;;) {
      const page = await text({ action: "payload", ref: "2.1/output", offset })
      const [head, ...rest] = page.split("\n")
      assert.match(head!, /^\[2\.1\/output\] tool Bash \(completed\) · chars /)
      const body = rest.join("\n")
      const more = /\n\nMore: payload ref="2\.1\/output" offset=(\d+)\.$/.exec(body)
      whole += more ? body.slice(0, more.index) : body
      pages++
      if (!more) break
      assert.ok(body.length - more[0].length <= 24_000, "a page fits under every harness's limit")
      offset = Number(more[1])
    }
    assert.equal(whole, BIG, "paged back exactly")
    assert.ok(pages >= 5, `${pages} pages`)

    // search: newest first, this session before the fork, the fork's inherited turn not counted twice, regex too.
    const needle = await text({ action: "search", query: "needle-at-the-end" })
    assert.match(needle, /^1 hit for "needle-at-the-end"/)
    assert.match(needle, /\[2\.1\/output\] tool Bash \(completed\): …[^\n]*«NEEDLE-AT-THE-END»/)
    const marker = await text({ action: "search", query: "inherited marker" })
    assert.match(marker, /^1 hit/, "the fork's inherited turn is its parent's")
    assert.match(marker, /\[1\.1\/text\] thinking/)
    const parser = await text({ action: "search", query: "pars(er|ing)", regex: true })
    assert.match(parser, /^\d+ hits for "pars\(er\|ing\)", newest first/)
    assert.ok(parser.indexOf("[1.") > 0 && parser.indexOf("[1.") < parser.indexOf("[2:2.1/text] reply"), `this session first, then the fork:\n${parser}`)
    assert.match(await text({ action: "search", query: "Bash" }), /\[2\.1\] tool Bash/, "tool names are searched")
    assert.match(await text({ action: "search", query: "zebra" }), /^No match for "zebra" across 5 turns\./, "the fork's inherited turn is searched once")
    const within = await text({ action: "search", query: "parser", turns: "2:2" })
    assert.match(within, /^2 hits for "parser" in turns 2:2/)
    const badRegex = await call({ action: "search", query: "(", regex: true })
    assert.ok(badRegex.isError && /doesn't parse/.test(badRegex.content[0]!.text))

    // A referenced native session, read from the catalog, its shortened entry read whole by id.
    const notes = await text({ action: "turns", thread: "thread:test-alpha:native-e" })
    assert.match(notes, /^Thread "Old parser notes" · test-alpha: turns 1–2\.\nTurns 1–2 of 2\.\n1 Write down the parser notes → 1 tool \(Read 1\) · "The tokenizer must keep trailing commas\."\n2 Ship the parser \(\+30 messages sent while it worked, below\) → 30 replies, last: "Checked case 29\."\n/)
    // Each message sent into a turn while the agent worked, under its turn, as the transcript's index lists them: the same refs and words, the same cap.
    const subLines = (listing: string) => listing.split("\n").filter((line) => /^ {2}- \d+\.\d+: "/.test(line)).map((line) => line.replace(/^ {2}- /, ""))
    assert.match(notes, new RegExp(`^ {2}- ${30 - STEER_LINES} earlier messages not listed: turns="2" lists every one$`, "m"))
    const built = await buildTranscript({ entries: threadE.entries, harness: ALPHA })
    const indexed = built.markdown.split("\n").filter((line) => /^ {2}- \d+\.\d+ \(line \d+\): "/.test(line)).map((line) => line.replace(/^ {2}- /, "").replace(/ \(line \d+\)/, ""))
    assert.equal(indexed.length, STEER_LINES)
    assert.deepEqual(subLines(notes), indexed, "thread_history turns and the transcript's index agree")
    assert.ok(built.markdown.includes(`  - ${30 - STEER_LINES} earlier messages not listed: \`thread_history\` turns="2" lists every one`))
    // Asked for the turn, every one; from an entry on, the rest.
    const all = subLines(await text({ action: "turns", thread: "thread:test-alpha:native-e", turns: "2" }))
    assert.deepEqual(all, Array.from({ length: 30 }, (_, n) => `2.${1 + 2 * n}: "Steer ${n}: check case ${n}"`))
    assert.deepEqual(subLines(await text({ action: "turns", thread: "thread:test-alpha:native-e", turns: "2.55" })), all.slice(27))
    // A ref jumps there.
    assert.match(await text({ action: "read", thread: "thread:test-alpha:native-e", turns: "2.59-2.59" }), /\[2\.59\] prompt \(steering\)\nSteer 29: check case 29\nwith a second line/)
    const notesTool = await text({ action: "payload", thread: "thread:test-alpha:native-e", ref: "1.1" })
    assert.match(notesTool, /^\[1\.1\/output\] tool Read \(completed\) · chars 0–24,000 of 50,000\nwhole notes/)

    // Scoping: a thread nobody referenced is refused, with what is readable.
    const refused = await call({ action: "turns", thread: "thread:test-alpha:native-x" })
    assert.ok(refused.isError, "an unreferenced thread is refused")
    assert.match(refused.content[0]!.text, /thread:test-alpha:native-x isn't one this Thread's messages referenced.*thread:test-alpha:native-d, thread:test-alpha:native-e/)
    assert.ok(!opened.includes(pathX), "nothing of it is read")

    // A referenced conversation whose history isn't read yet: the answer waits for it.
    let answered = false
    const pending = text({ action: "read", thread: "thread:test-alpha:native-d", turns: "1" }).then((value) => {
      answered = true
      return value
    })
    await delay(150)
    assert.equal(answered, false, "it waits for the history to be read")
    gate.open()
    assert.match(await pending, /\[1\.1\] reply\nD decided on SQLite with WAL\./)

    // A grant whose binding isn't running a turn reads nothing.
    const stale = await connect(bB, idB)
    const denied = Result.parse(await stale.callTool({ name: "thread_history", arguments: { action: "turns" } }))
    assert.ok(denied.isError && /no longer owns an active turn/.test(denied.content[0]!.text), "a grant without a running turn is refused")
    await stale.close()

    // Bad input says what it takes.
    const badRange = await call({ action: "read", turns: "9" })
    assert.ok(badRange.isError && /This session has turns 1–4; 9 isn't one/.test(badRange.content[0]!.text))
    const badSession = await call({ action: "read", turns: "3:1" })
    assert.ok(badSession.isError && /sessions 1–2/.test(badSession.content[0]!.text))
    const badRef = await call({ action: "payload", ref: "2.9" })
    assert.ok(badRef.isError && /Turn 2 has entries 2\.0–2\.2/.test(badRef.content[0]!.text))
    console.log("PASS: thread_history over the mako server: turns, read, search, payload, references, scoping, a switched harness, a fork, paging")
  } finally {
    await agent.close()
    servers.close()
    await live.stop()
    threads.close()
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
