import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { finPullRequests, type AgentCaller, type AgentRefused } from "@mako/host/contracts/agents"
import type { AgentOperations, AgentsListInput, AgentsListResult, AgentsReadInput, PlacementOperations } from "@mako/host/contracts/agent-tools"
import { decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { AgentListResults } from "@mako/host/conversations/agent-list-results"
import { AgentAnswerSchema, declareAgentMethods, registerAgentTools } from "@mako/host/conversations/agent-tools"
import { HostMethods } from "@mako/host/transport/methods"

const owner: AgentCaller = { kind: "agent", session: "fixture-owner" }
const stranger: AgentCaller = { kind: "agent", session: "fixture-stranger" }
const denied: AgentRefused = { refused: "no-parent", why: "This caller has no authorized tree." }
const unavailable = async (): Promise<AgentRefused> => ({ refused: "unavailable", why: "Not part of this read-only fixture." })
const full = {
  children: Array.from({ length: 57 }, (_, index) => {
    const number = 1000 + index * 20
    const url = (value: number) => `https://github.com/example/offline-proof/pull/${value}`
    const openPRs = finPullRequests([
      { number, url: url(number), state: "open" },
      { number: number + 1, url: url(number + 1), state: "merged" },
      { number: number + 2, url: url(number + 2), state: "closed" },
    ], Array.from({ length: 8 }, (_, i) => ({ artifacts: [{ kind: "pull-request", ref: url(number + i) }] })))
    return {
      child: `fixture-child-${index}`, name: `offline-fin-${String(index).padStart(2, "0")}`,
      harness: "codex", model: "fixture-model", origin: "started" as const,
      state: index === 0 ? { kind: "blocked" as const, on: "lead" as const, question: "Which acceptance criterion applies?" }
        : { kind: "ended" as const, outcome: index === 56 ? "failed" as const : "done" as const, ...(index === 56 && { reason: "Late failing check; mutation outcome unknown. Do not retry." }) },
      title: `Investigate task ${index} and verify the resulting change`, toolUses: 14,
      report: { status: "done" as const, line: `Completed fixture-child-${index}; isolated verification passed and evidence is retained.`, at: 1_799_999_880_000 },
      ...(index === 0 && { pendingQuestions: 1 }),
      waiting: index === 1 ? "Waiting on external check" : undefined,
      idleFor: 120, openPRs, startedAt: 1_800_000_000_000 - (index + 1) * 60_000,
    }
  }),
  tree: { running: 0, started: 57, of: { running: 4, started: 100 } },
  extraOutcome: { earlyFailure: "First check failed", unknownMutation: "Never replay an unknown effect" },
} satisfies AgentsListResult & { extraOutcome: { earlyFailure: string; unknownMutation: string } }
const original = structuredClone(full)
let allowed = true
let throwOnList = false
let listCalls = 0
let readCalls = 0
const operations: AgentOperations & PlacementOperations = {
  start: unavailable, move: unavailable, link: unavailable, report: unavailable, send: unavailable, answer: unavailable, settle: unavailable, stop: unavailable, wait: unavailable,
  capabilities: () => ({ orchestration: { version: 1 }, slots: { used: 0, of: 1 }, harnesses: [] }),
  place: unavailable, cancel: unavailable, notice: async () => ({ heard: true }),
  list: async (caller) => {
    listCalls++
    if (throwOnList) throw new Error("Unknown mutation outcome; do not retry.")
    return allowed && caller.kind === "agent" && caller.session === owner.session ? full : denied
  },
  read: async (caller, input) => {
    readCalls++
    if (!allowed || caller.kind !== "agent" || caller.session !== owner.session) return denied
    const child = full.children.find(entry => entry.child === input.child)
    return child ? { child: child.child, name: child.name, state: child.state, text: "Original report read, unchanged." } : { refused: "unknown-child", why: "Unknown fixture Fin." }
  },
}
function freshMethods(): HostMethods {
  const table = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: value => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  declareAgentMethods(table, () => operations)
  return table
}
const methods = freshMethods()
const invoke = async (channel: "mako:agents-list" | "mako:agents-read", input: AgentsListInput | AgentsReadInput, caller = owner) => decodeRuntimeValue(await methods.invoke(channel, [caller, input]))
const toolResult = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() })
const summarySchema = z.looseObject({
  children: z.array(z.looseObject({ child: z.string(), name: z.string(), state: z.json(), pulls: z.object({ open: z.number(), draft: z.number(), reported: z.number(), read: z.object({ child: z.string(), view: z.literal("pulls"), snapshot: z.string() }), expiresAt: z.number() }) })),
})
const pageSchema = z.object({ child: z.string(), text: z.string(), pulls: z.object({ snapshot: z.string(), offset: z.number(), total: z.number(), next: z.number().optional() }) })
const server = new McpServer({ name: "list-results-fixture", version: "1" })
registerAgentTools(server, { caller: () => owner, filled: () => ({}), invoke: async (channel, args) => AgentAnswerSchema.parse(decodeRuntimeValue(await methods.invoke(channel, args))) })
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
await server.connect(serverSide)
const client = new Client({ name: "offline-list-result-check", version: "1" })
await client.connect(clientSide)
const call = async (name: string, input: Parameters<Client["callTool"]>[0]["arguments"]) => toolResult.parse(await client.callTool({ name, arguments: input }))
const size = (value: z.infer<typeof toolResult>) => Buffer.byteLength(JSON.stringify(value))
try {
  const listed = await client.listTools()
  assert.ok(listed.tools.find(tool => tool.name === "agents_read")?.inputSchema.properties?.snapshot)
  assert.ok(listed.tools.find(tool => tool.name === "agents_list")?.inputSchema.properties?.presentation)
  const baseline = await call("agents_list", { presentation: "full" })
  assert.deepEqual(JSON.parse(baseline.content[0].text), JSON.parse(JSON.stringify(full)))
  const defaultOutput = await call("agents_list", {})
  assert.deepEqual(defaultOutput, baseline, "MCP default preserves every original PR fact inline")
  assert.match(listed.tools.find(tool => tool.name === "agents_list")!.description!, /Every PR fact stays inline by default/)
  assert.match(listed.tools.find(tool => tool.name === "agents_list")!.description!, /original facts cannot be recovered/)
  assert.deepEqual(await invoke("mako:agents-list", {}), JSON.parse(JSON.stringify(full)), "non-model host callers retain full facts")
  const compact = await call("agents_list", { presentation: "summary" })
  assert.equal(compact.isError, undefined)
  const parsed = summarySchema.parse(JSON.parse(compact.content[0].text))
  assert.deepEqual(parsed.extraOutcome, full.extraOutcome, "top-level failure and unknown-outcome facts remain")
  assert.equal(parsed.children.length, 57)
  for (let i = 0; i < parsed.children.length; i++) {
    const { openPRs: _pr, ...facts } = full.children[i]
    const { pulls, ...summaryFacts } = parsed.children[i]
    assert.deepEqual(summaryFacts, JSON.parse(JSON.stringify(facts)), "all state/decision/failure fields stay byte-equivalent")
    assert.deepEqual([pulls.open, pulls.draft, pulls.reported], [1, 0, 5])
  }
  assert.deepEqual(full, original, "projection never mutates the engine/UI result")
  const repeated = summarySchema.parse(JSON.parse((await call("agents_list", { presentation: "summary" })).content[0].text))
  assert.equal(repeated.children[0].pulls.read.snapshot, parsed.children[0].pulls.read.snapshot, "unchanged facts reuse a stable reference")
  let followupBytes = 0
  let firstDetailBytes = 0
  for (const [index, child] of parsed.children.entries()) {
    const recovered: unknown[] = []
    let offset: number | undefined = 0
    while (offset !== undefined) {
      const output = await call("agents_read", { ...child.pulls.read, offset, limit: 2 })
      assert.equal(output.isError, undefined)
      followupBytes += size(output)
      if (index === 0) firstDetailBytes += size(output)
      const page = pageSchema.parse(JSON.parse(output.content[0].text))
      assert.equal(page.pulls.offset, offset)
      recovered.push(...z.array(z.json()).parse(JSON.parse(page.text)))
      if (page.pulls.next !== undefined) assert.ok(page.pulls.next > offset)
      offset = page.pulls.next
    }
    assert.deepEqual(recovered, full.children[index].openPRs, "every original fact/order/dedup/state survives paging")
  }
  const ref = parsed.children[0].pulls.read
  const secondServer = new McpServer({ name: "second-request-fixture", version: "1" })
  registerAgentTools(secondServer, { caller: () => owner, filled: () => ({}), invoke: async (channel, args) => AgentAnswerSchema.parse(decodeRuntimeValue(await methods.invoke(channel, args))) })
  const [secondServerSide, secondClientSide] = InMemoryTransport.createLinkedPair()
  const secondClient = new Client({ name: "second-request", version: "1" })
  try {
    await secondServer.connect(secondServerSide)
    await secondClient.connect(secondClientSide)
    const recovered = toolResult.parse(await secondClient.callTool({ name: "agents_read", arguments: ref }))
    assert.equal(recovered.isError, undefined, "a new MCP server instance reads the host-held snapshot")
    const page = pageSchema.parse(JSON.parse(recovered.content[0].text))
    assert.deepEqual(JSON.parse(page.text), full.children[0].openPRs)
  } finally {
    await secondClient.close()
    await secondServer.close()
  }
  const empty = pageSchema.parse(JSON.parse((await call("agents_read", { ...ref, offset: 6 })).content[0].text))
  assert.equal(empty.text, "[]")
  assert.equal(empty.pulls.next, undefined)
  for (const input of [{ ...ref, offset: -1 }, { ...ref, offset: 0.5 }, { ...ref, offset: 7 }, { ...ref, limit: 0 }, { ...ref, limit: 21 }, { ...ref, report: "other" }, { ...ref, maxChars: 1 }, { ...ref, snapshot: "missing" }, { ...ref, child: "not-owned" }]) {
    const output = await call("agents_read", input)
    assert.equal(output.isError, true, JSON.stringify(input))
  }
  const beforeAuth = readCalls
  const beforeList = listCalls
  allowed = false
  assert.deepEqual(await invoke("mako:agents-read", ref), denied, "revocation wins over a retained snapshot")
  assert.equal(readCalls, beforeAuth + 1)
  assert.equal(listCalls, beforeList, "a detail page does not rescan every Fin's list")
  allowed = true
  assert.deepEqual(await invoke("mako:agents-read", ref, stranger), denied)
  const read = await call("agents_read", { child: full.children[0].child })
  assert.match(read.content[0].text, /Original report read, unchanged/)
  throwOnList = true
  const failed = await call("agents_list", {})
  assert.equal(failed.isError, true)
  assert.equal(failed.content[0].text, "Unknown mutation outcome; do not retry.")
  throwOnList = false

  let clock = 0
  const snapshots = new AgentListResults(() => clock)
  const authorized = { child: full.children[0].child, name: full.children[0].name, state: full.children[0].state, text: "Authorized read" }
  const changed = structuredClone(full)
  const snapshot = summarySchema.parse(snapshots.summarize(owner, changed)).children[0].pulls.read
  const before = snapshots.read(owner, authorized, snapshot)
  assert.ok(!("refused" in before))
  changed.children[0].openPRs.reverse()
  assert.deepEqual(snapshots.read(owner, authorized, snapshot), before, "live PR changes do not shift retained page order")
  assert.ok("refused" in snapshots.read(owner, { refused: "unknown-child", why: "No longer owned" }, snapshot), "removing the Fin from the caller's tree revokes its details")
  assert.ok("refused" in snapshots.read(stranger, authorized, snapshot), "another caller cannot borrow a retained reference")
  let capacityFallbacks = 0
  for (let i = 0; i < 40; i++) {
    const different = structuredClone(full)
    different.children[0].openPRs[0].number += i + 1
    if (snapshots.summarize(owner, different) === different) capacityFallbacks++
  }
  assert.ok(capacityFallbacks > 0, "retention pressure keeps later facts inline")
  assert.deepEqual(snapshots.read(owner, authorized, snapshot), before, "capacity never evicts a valid recovery reference")
  const long = structuredClone(full)
  long.children[0].openPRs[0].url = "https://example.invalid/" + "x".repeat(3 * 1024 * 1024)
  assert.equal(snapshots.summarize(owner, long), long, "an unretainable result keeps full facts inline")
  const many = structuredClone(full)
  many.children[0].openPRs = Array.from({ length: 41 }, (_, i) => ({ number: i, state: i === 0 ? "draft" as const : "reported" as const, url: `https://example.invalid/${i}` }))
  const pageStore = new AgentListResults(() => 0)
  const short = structuredClone(full)
  short.children[0].openPRs = [1, 2, 3].map(number => ({ number, state: "reported" as const }))
  const smallResult = pageStore.summarize(owner, short)
  assert.ok("children" in smallResult)
  const smallRow = smallResult.children[0]
  assert.ok("openPRs" in smallRow)
  assert.deepEqual(smallRow.openPRs, short.children[0].openPRs, "small arrays stay inline when recovery metadata would cost more")
  const manySummary = summarySchema.parse(pageStore.summarize(owner, many))
  assert.deepEqual([manySummary.children[0].pulls.open, manySummary.children[0].pulls.draft, manySummary.children[0].pulls.reported], [0, 1, 40])
  const manyRef = manySummary.children[0].pulls.read
  const pages = [0, 20, 40].map(offset => pageStore.read(owner, authorized, { ...manyRef, offset }))
  assert.deepEqual(pages.flatMap(page => {
    assert.ok(!("refused" in page))
    return z.array(z.json()).parse(JSON.parse(page.text))
  }), many.children[0].openPRs, "default 20-record pages preserve boundary order without repeats/loss")
  const unicode = structuredClone(full)
  unicode.children[0].openPRs[0].url = "https://example.invalid/" + "界".repeat(1000)
  const unicodeRef = summarySchema.parse(pageStore.summarize(owner, unicode)).children[0].pulls.read
  const unicodePage = pageStore.read(owner, authorized, { ...unicodeRef, limit: 1 })
  assert.ok(!("refused" in unicodePage))
  assert.deepEqual(JSON.parse(unicodePage.text), unicode.children[0].openPRs.slice(0, 1), "a long Unicode fact is delivered whole, not report-tail truncated")
  const byteBound = structuredClone(full)
  byteBound.children[0].openPRs = Array.from({ length: 6 }, (_, number) => ({ number, state: "reported" as const, url: "https://example.invalid/" + "界".repeat(2000) }))
  const byteRef = summarySchema.parse(pageStore.summarize(owner, byteBound)).children[0].pulls.read
  const byteRecovered: unknown[] = []
  let byteOffset: number | undefined = 0
  while (byteOffset !== undefined) {
    const page = pageStore.read(owner, authorized, { ...byteRef, offset: byteOffset })
    assert.ok(!("refused" in page))
    assert.ok(Buffer.byteLength(page.text) <= 16_000)
    byteRecovered.push(...z.array(z.json()).parse(JSON.parse(page.text)))
    byteOffset = page.pulls.next
  }
  assert.deepEqual(byteRecovered, byteBound.children[0].openPRs, "byte-limited pages also recover every fact")
  unicode.children[0].openPRs[0].url = "https://example.invalid/" + "界".repeat(9000)
  const tooLong = pageStore.summarize(owner, unicode)
  assert.ok("children" in tooLong)
  const kept = tooLong.children[0]
  assert.ok("openPRs" in kept)
  assert.deepEqual(kept.openPRs, unicode.children[0].openPRs, "an individually unpageable fact stays inline")
  clock = 29 * 60_000
  const reused = summarySchema.parse(snapshots.summarize(owner, full)).children[0]
  assert.equal(reused.pulls.read.snapshot, snapshot.snapshot)
  assert.equal(reused.pulls.expiresAt, 30 * 60_000, "explicit summary reuse does not promise a new 30 minutes")
  clock = 30 * 60_000
  assert.ok("refused" in snapshots.read(owner, authorized, snapshot), "expiration is explicit")
  assert.ok("refused" in new AgentListResults().read(owner, authorized, snapshot), "host restart does not fabricate a payload")
  assert.deepEqual(snapshots.summarize(owner, { refused: "conflict", why: "unknown outcome" }), { refused: "conflict", why: "unknown outcome" })
  // A default response carries its evidence already. Neither a relist nor a volatile handle is its recovery route.
  full.children[0].openPRs[0].state = "draft"
  full.children[0].openPRs.splice(1, 1)
  full.children[0].openPRs.reverse()
  assert.notDeepEqual(full.children[0].openPRs, original.children[0].openPRs)
  const restartedMethods = freshMethods()
  const restartedServer = new McpServer({ name: "fresh-host-methods", version: "1" })
  registerAgentTools(restartedServer, { caller: () => owner, filled: () => ({}), invoke: async (channel, args) => AgentAnswerSchema.parse(decodeRuntimeValue(await restartedMethods.invoke(channel, args))) })
  const [restartServerSide, restartClientSide] = InMemoryTransport.createLinkedPair()
  const restartedClient = new Client({ name: "fresh-host-client", version: "1" })
  try {
    await restartedServer.connect(restartServerSide)
    await restartedClient.connect(restartClientSide)
    const current = toolResult.parse(await restartedClient.callTool({ name: "agents_list", arguments: {} }))
    assert.deepEqual(JSON.parse(current.content[0].text), JSON.parse(JSON.stringify(full)), "fresh method instance also defaults to full, including changed facts")
    assert.deepEqual(JSON.parse(defaultOutput.content[0].text), JSON.parse(JSON.stringify(original)), "after 30 minutes and a fresh host's changed facts, the original default response still contains every ordered fact")
    const lost = toolResult.parse(await restartedClient.callTool({ name: "agents_read", arguments: ref }))
    assert.equal(lost.isError, true, "explicit opt-in pages remain honestly unavailable after host restart")
    assert.match(lost.content[0].text, /original facts cannot be recovered here/)
  } finally {
    await restartedClient.close()
    await restartedServer.close()
    full.children[0] = structuredClone(original.children[0])
  }
  const output = {
    fins: 57, fullTextBytes: Buffer.byteLength(baseline.content[0].text), summaryTextBytes: Buffer.byteLength(compact.content[0].text),
    defaultTextBytes: Buffer.byteLength(defaultOutput.content[0].text), defaultEnvelopeBytes: size(defaultOutput),
    fullEnvelopeBytes: size(baseline), summaryEnvelopeBytes: size(compact),
    summaryPlusOneFinDetailBytes: size(compact) + firstDetailBytes,
    summaryPlusAllFinDetailBytes: size(compact) + followupBytes,
    note: "All bytes are result envelopes/text. No provider tokens, request-schema overhead or money measured; all-detail reads can cost more.",
  }
  console.log(JSON.stringify(output))
  console.log("agent list results: schema roundtrip, 57 identities/states, original PR pages, ownership, retention and errors passed")
} finally {
  await client.close()
  await server.close()
}
