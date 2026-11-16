import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Entry } from "@mako/sessions/entries"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { ColdJournal, LiveJournal } from "@mako/host/conversations/live-journal"
import { JournalReclaims } from "@mako/host/conversations/journal-reclaim"
import { NativeAgentSchema } from "@mako/host/contracts/native-agents"
import { HistoryVersions, arrayBlocks, historyPage } from "@mako/host/contracts/history-pages"
import { HISTORY_VIEW_EXPIRED, type LiveHistoryChunk, type LiveHistoryPage, type LiveHistoryRead } from "@mako/host/contracts/live-history"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * A window reads a conversation no host holds in memory where its journal lies (`ColdJournal`): the same pages a
 * conversation in memory gives, from rows held as they were when the view opened, and the conversation is never read
 * in for it. Reading it in lets the cold views go; a journal its last host left running is read in as before.
 */
const harness = "test-provider"
const root = mkdtempSync(join(tmpdir(), "mako-cold-history-"))
const host = join(root, "host")
const requestId = (turn: number) => `00000000-0000-4000-8000-${turn.toString(16).padStart(12, "0")}`
const words = (n: number, chars: number) => `${n} `.repeat(Math.ceil(chars / `${n} `.length)).slice(0, chars)

/** A long conversation's blocks: prompts (one steering), a provider's own turn, thinking, calls with long output, replies. */
function blocksOf(turns: number): Entry[] {
  const blocks: Entry[] = []
  for (let turn = 0; turn < turns; turn++) {
    if (turn % 9 === 4) blocks.push({ type: "provider-turn", id: `pt-${turn}`, reason: "Its agent finished" })
    else blocks.push({ type: "user", id: `u-${turn}`, text: `Ask ${turn}`, requestId: requestId(turn) })
    blocks.push({ type: "thinking", id: `th-${turn}`, text: words(turn, 300) })
    blocks.push({ type: "tool", id: `call-${turn}`, name: "Bash", status: "completed", input: JSON.stringify({ command: `ls ${turn}` }), output: words(turn, turn % 5 ? 900 : 12_000) })
    if (turn % 7 === 3) blocks.push({ type: "user", id: `s-${turn}`, text: `Also ${turn}`, requestId: requestId(10_000 + turn), steeringFor: requestId(turn) })
    blocks.push({ type: "text", id: `t-${turn}`, text: words(turn, 500) })
  }
  return blocks
}

function snapshotOf(id: string, blocks: Entry[], status: LiveSnapshot["session"]["status"] = "ready", control?: LiveSnapshot["control"]): LiveSnapshot {
  const turns = blocks.filter((block) => block.type === "user" && block.requestId && !("steeringFor" in block && block.steeringFor))
  return {
    session: { id, harness, nativeId: `native-${id}`, cwd: root, title: "A long Fin", status, connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: 1, base: null, blocks, permissions: [], ...control && { control },
    requests: turns.map((block) => ({ id: block.type === "user" ? block.requestId! : "", text: "Ask", attachments: [], status: "completed" as const, createdAt: 1 })),
  }
}

/** Writes a journal as a host leaves it, then grows its last reply, so the journal keeps that as an append. */
function writeJournal(id: string, blocks: Entry[], status?: LiveSnapshot["session"]["status"], control?: LiveSnapshot["control"]): void {
  const journal = new LiveJournal(host, id)
  const first = snapshotOf(id, blocks, status, control)
  journal.commit(first)
  const last = blocks.at(-1)!
  const grown = last.type === "text" ? { ...last, text: `${last.text} and the end of it.` } : last
  journal.commit({ ...first, revision: 2, blocks: [...blocks.slice(0, -1), grown] }, first)
  journal.close()
}

async function read<T>(reader: LiveHistoryReader, live: LiveConversations, id: string, input: LiveHistoryRead): Promise<T> {
  let part: LiveHistoryChunk = await reader.read(id, input, () => live.refreshedSnapshot(id), () => live.coldView(id))
  const pieces = [part.data]
  while (part.next !== null) {
    part = await reader.read(id, { kind: "part", record: part.record, offset: part.next }, () => live.refreshedSnapshot(id))
    pieces.push(part.data)
  }
  // SAFETY: a history read's parts are the JSON of the typed value the reader answered.
  return JSON.parse(pieces.join("")) as T
}

/** A page as a window reads it, as JSON: its entries without the versions each reader numbers its own way. */
// SAFETY: these are entries, read back from their own JSON as a window reads them.
const unversioned = (entries: readonly Entry[]) => (JSON.parse(JSON.stringify(entries)) as Entry[]).map((entry) => {
  if (entry.type !== "tool" || !entry.historyVersion) return entry
  const { historyVersion: _version, ...rest } = entry
  return rest
})

const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  approvalEvidence: { kind: "submission-only", reason: "fixture" },
  launchEnvironment: { kind: "unavailable", reason: "fixture" },
  nativeIdentity: { kind: "unavailable", reason: "fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "fixture", feedback: { kind: "next-message", reason: "fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "fixture" },
  turnRecovery: { kind: "manual", reason: "fixture" },
  provider: harness,
  available: () => true,
  start: async () => { throw new Error("no session starts here") },
  prompt: async () => {}, permission: async () => {}, cancel: async () => {}, close: () => {}, setMode: async () => {},
}

const quiet = "00000000-0000-4000-9000-000000000001"
const running = "00000000-0000-4000-9000-000000000002"
const blocks = blocksOf(240)
writeJournal(quiet, blocks)
writeJournal(running, blocksOf(12), "running")
const long = "00000000-0000-4000-9000-000000000003"
writeJournal(long, blocksOf(3000))
// One binding whose session holds the whole history: a read may refresh it from the harness's record, so it's read in.
// One that covers none of it: nothing to refresh, read cold.
const bound = (id: string, covered: number): LiveSnapshot["control"] => ({ merges: [], transfers: [], activeBindingId: id,
  bindings: [{ id, provider: harness, nativeId: `native-${id}`, path: join(root, `native-${id}`), coveredBlocks: covered, includesBase: true }] })
const refreshable = "00000000-0000-4000-9000-000000000004"
const opened12 = blocksOf(12)
writeJournal(refreshable, opened12, "ready", bound(refreshable, opened12.length))
const uncovered = "00000000-0000-4000-9000-000000000005"
writeJournal(uncovered, blocksOf(12), "ready", bound(uncovered, 0))
const raced = "00000000-0000-4000-9000-000000000006"
writeJournal(raced, blocksOf(30))
// An Apex: its Fins are its children engine's, never its journal's.
const fin = NativeAgentSchema.parse({ nativeId: "mako-child:fin", title: "fin-1", bindingId: "mako:children", provider: "mako", observedAt: 1,
  state: { kind: "working" }, child: { thread: "00000000-0000-4000-8000-00000000f1f1", name: "fin-1", origin: "started" } })
const whole = new LiveJournal(host, quiet)
const expected = whole.read()!
whole.close()
const reply = expected.blocks.at(-1)
assert.ok(reply?.type === "text" && reply.text.endsWith("and the end of it."), "the journal kept the reply's end as an append")

let reader!: LiveHistoryReader
const live = new LiveConversations({
  appPath: root, root: host, driver: () => driver, emit: () => {},
  history: async () => null,
  historyPaged: (id) => reader.paged(id),
  historyReleased: (id) => reader.released(id),
  historyLoaded: (id) => reader.loaded(id),
  historyHeld: () => reader.coldBytes(),
  historyHolds: (key) => reader.holds(key),
  agents: () => ({
    roster: (id) => (id === quiet ? [fin] : []),
    stopChild: async () => false, settled: () => {}, isApex: () => true, frontDoor: () => [], ruleLines: () => ({}),
  }),
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
})
reader = new LiveHistoryReader(undefined, undefined, undefined, (id) => live.held(id))
try {
  // The newest page, read where the journal lies: nothing of the conversation is read in.
  const opened = await read<LiveSnapshot>(reader, live, quiet, { kind: "snapshot" })
  assert.equal(live.held(quiet), undefined, "a window's read leaves the conversation on disk")
  assert.equal(live.residency().memory.loaded, 0)
  assert.equal(opened.session.status, "ready")
  assert.deepEqual(opened.nativeAgents?.agents.map((agent) => agent.child?.name), ["fin-1"], "an Apex read cold shows its Fins, as read in")
  assert.equal(opened.requests.length, expected.requests.length)
  const token = opened.history!.token
  const versions = new HistoryVersions()
  const tail = historyPage(token, expected, { blocks: expected.blocks.length, base: 0 }, versions, arrayBlocks(expected.blocks))
  assert.deepEqual(unversioned(opened.blocks), unversioned(tail.blocks), "the newest page is the one memory would give")
  assert.deepEqual(opened.history, tail.history, "with the same counts of turns and requests before it")

  // Every earlier page, back to the first, as memory would give it.
  let before = opened.history!.before
  let pages = 0
  let previewed: Entry | undefined
  while (before) {
    const page = await read<LiveHistoryPage>(reader, live, quiet, { kind: "earlier", token, before })
    const memory = historyPage(token, expected, before, versions, arrayBlocks(expected.blocks))
    assert.deepEqual(unversioned(page.blocks), unversioned(memory.blocks), `page ${pages} is the one memory would give`)
    assert.deepEqual(page.history, memory.history, `page ${pages}'s counts`)
    previewed ??= page.blocks.find((block) => block.type === "tool" && block.historyRest)
    before = page.history.before
    pages++
  }
  assert.ok(pages > 3, "the conversation has several pages")
  assert.equal(live.held(quiet), undefined, "paging back reads nothing in")

  // A call's whole output, read by the version its preview named.
  assert.ok(previewed?.type === "tool" && previewed.historyVersion)
  const index = expected.blocks.findIndex((block) => block.id === previewed!.id)
  const detail = await read<Entry>(reader, live, quiet, { kind: "detail", token, at: { kind: "live", index } })
  assert.ok(detail.type === "tool")
  assert.equal(detail.output, expected.blocks[index]!.type === "tool" ? expected.blocks[index]!.output : undefined, "the whole output")
  assert.equal(detail.historyVersion, previewed.historyVersion, "the version its preview named")
  assert.ok(reader.coldBytes() > 0, "what the view read is counted for the conversations' budget")
  // Nothing compacts a journal a cold view holds: its read transaction would hold the compaction up.
  const key = join(realpathSync(host), `${quiet}.sqlite`)
  assert.ok(reader.holds(key))
  assert.deepEqual(await new JournalReclaims((held) => reader.holds(held)).reclaim(join(host, `${quiet}.sqlite`)), { skipped: true }, "a compaction skips a journal a cold view holds")

  // Rows written after the view opened don't reach it: its read transaction holds the journal as it was.
  const writer = new LiveJournal(host, quiet)
  const now = writer.read()!
  writer.commit({ ...now, revision: now.revision + 1, blocks: [...now.blocks, { type: "text", id: "later", text: "Written later" }] }, now)
  writer.close()
  const again = await read<LiveHistoryPage>(reader, live, quiet, { kind: "earlier", token, before: opened.history!.before! })
  assert.deepEqual(unversioned(again.blocks), unversioned(historyPage(token, expected, opened.history!.before!, versions, arrayBlocks(expected.blocks)).blocks))

  // Reading the conversation in lets its cold views go: a window reading one opens it again, from memory.
  assert.ok(live.snapshot(quiet))
  assert.equal(reader.coldBytes(), 0, "its cold view went when it was read in")
  await assert.rejects(read(reader, live, quiet, { kind: "earlier", token, before: opened.history!.before! }), new RegExp(HISTORY_VIEW_EXPIRED.slice(0, 30)))
  const reopened = await read<LiveSnapshot>(reader, live, quiet, { kind: "snapshot" })
  assert.equal(reopened.blocks.at(-1)?.id, "later", "read again, from memory, with what was written since")

  // One its last host left running is read in, as a window's read always did.
  assert.equal(await live.coldView(running), undefined)
  await read<LiveSnapshot>(reader, live, running, { kind: "snapshot" })
  assert.ok(live.held(running), "read in")

  assert.equal(ColdJournal.open(host, "00000000-0000-4000-9000-00000000ffff"), undefined, "no journal, no cold view")

  // One a read could refresh from its harness's record is read in, where that refresh runs; one with nothing to refresh isn't.
  assert.equal(await live.coldView(refreshable), undefined, "a single binding holding the whole history is read in")
  const cold = await live.coldView(uncovered)
  assert.ok(cold, "a binding that covers none of it is read cold")
  cold.journal.close()

  // Read in between the cold journal opening and its view being held: the view isn't held, the read is from memory.
  const read0 = await reader.read(raced, { kind: "snapshot" }, () => live.refreshedSnapshot(raced), async () => {
    const opening = await live.coldView(raced)
    assert.ok(live.snapshot(raced), "read in meanwhile")
    return opening
  })
  assert.ok(read0.data.length > 0)
  assert.equal(reader.holds(join(realpathSync(host), `${raced}.sqlite`)), false, "no view pins a journal a host now writes")

  // A long one's first read goes on a turn at a time: its requests are parsed a slice at a time, its page on a turn of
  // its own. Read whole, a 122 MB Fin's held the loop 73 ms opening and 41 ms paging.
  let longest = 0
  let last = performance.now()
  const sampler = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now }, 1)
  const longRead = await read<LiveSnapshot>(reader, live, long, { kind: "snapshot" })
  clearInterval(sampler)
  assert.equal(longRead.requests.length, snapshotOf(long, blocksOf(3000)).requests.length, "every request")
  assert.ok(longest < 50, `the loop was held ${Math.round(longest)} ms`)
  assert.equal(live.held(long), undefined)
  console.log(`cold history: a 3,000-turn journal's first read held the loop at most ${Math.round(longest)} ms`)
  console.log(`cold history: ${pages + 1} pages and a call's whole output read where the journal lies, the same as memory gives, nothing read in; reading it in lets the view go`)
} finally {
  await live.stop()
  rmSync(root, { recursive: true, force: true })
}
