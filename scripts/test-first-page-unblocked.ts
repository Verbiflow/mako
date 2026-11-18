import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Entry } from "@mako/sessions/entries"
import type { ThreadPage } from "@mako/sessions"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import type { LiveHistoryChunk, LiveHistoryRead } from "@mako/host/contracts/live-history"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * A window's first page of a conversation whose history is its session's record never waits on the sync daemon, which
 * reads that record: it's shown at once as its journal holds it, and again once the record is read. The person's host
 * waited 10.5 s, and 80 to 163 s behind the daemon's queue after a restart, for "history could not be read from its
 * session". A cold view of such a conversation asked the daemon too, so a window's read doesn't take one.
 */
const harness = "test-provider"
const root = mkdtempSync(join(tmpdir(), "mako-first-page-"))
const host = join(root, "host")
const recordPath = join(root, "native-record.jsonl")
const recordEntries: Entry[] = Array.from({ length: 120 }, (_, n) => n % 4 === 0
  ? { type: "user", id: `r-u-${n}`, text: `Recorded ask ${n}` }
  : { type: "text", id: `r-t-${n}`, text: `Recorded reply ${n}` })

// The daemon: it answers nothing until let go, as one held behind its queue.
let letGo!: () => void
const queued = new Promise<void>((resolve) => { letGo = resolve })
let asked = 0
const history = async (path: string, before?: number): Promise<ThreadPage | null> => {
  asked++
  await queued
  if (path !== recordPath) return null
  const end = before ?? recordEntries.length
  const start = Math.max(0, end - 50)
  return { ref: { harness, nativeId: "native-record", path: recordPath, title: "Recorded" }, entries: recordEntries.slice(start, end), start, total: recordEntries.length, hasEarlier: start > 0 }
}

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

// A conversation whose record covers its first blocks, with a turn of its own after them.
const id = "00000000-0000-4000-9000-000000000021"
const own: Entry[] = [
  { type: "user", id: "c-u", text: "Covered ask", requestId: "00000000-0000-4000-8000-000000000001" },
  { type: "text", id: "c-t", text: "Covered reply" },
  { type: "user", id: "n-u", text: "A later ask", requestId: "00000000-0000-4000-8000-000000000002" },
  { type: "text", id: "n-t", text: "Its reply" },
]
{
  const journal = new LiveJournal(host, id)
  journal.commit({
    session: { id, harness, nativeId: "native-record", cwd: root, title: "A recorded Fin", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: 1, base: null, blocks: own, permissions: [], requests: [],
    baseSource: { harness, nativeId: "native-record", path: recordPath }, baseCoveredBlocks: 2, baseLiveStart: 0,
  })
  journal.close()
}

let reader!: LiveHistoryReader
const emitted: string[] = []
const live = new LiveConversations({
  appPath: root, root: host, driver: () => driver, emit: (event) => { emitted.push(event.type) },
  history,
  historyPaged: (each) => reader.paged(each),
  historyReleased: (each) => reader.released(each),
  historyLoaded: (each) => reader.loaded(each),
  historyHeld: () => reader.coldBytes(),
  historyHolds: (key) => reader.holds(key),
  agents: () => ({ roster: () => [], stopChild: async () => false, settled: () => {}, isApex: () => false, frontDoor: () => [], ruleLines: () => ({}) }),
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
})
reader = new LiveHistoryReader(history, undefined, undefined, (each) => live.held(each))

async function windowRead(input: LiveHistoryRead): Promise<LiveSnapshot> {
  let part: LiveHistoryChunk = await reader.read(id, input, () => live.windowSnapshot(id), () => live.coldView(id, false, undefined, true))
  const pieces = [part.data]
  while (part.next !== null) {
    part = await reader.read(id, { kind: "part", record: part.record, offset: part.next }, () => live.windowSnapshot(id))
    pieces.push(part.data)
  }
  // SAFETY: a history read's parts are the JSON of the typed value the reader answered.
  return JSON.parse(pieces.join("")) as LiveSnapshot
}

try {
  // The daemon answers nothing: the window's first page comes anyway, from the journal, every block of it.
  const started = performance.now()
  const first = await Promise.race([
    windowRead({ kind: "snapshot" }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the first page waited on the daemon")), 2_000)),
  ])
  const waited = performance.now() - started
  assert.ok(asked > 0, "the record was asked for")
  assert.equal(first.base, null, "the record isn't read yet")
  assert.deepEqual(first.blocks.map((block) => block.id), own.map((block) => block.id), "every block the journal holds, the covered ones too")
  assert.equal(first.baseCoveredBlocks, 0)

  // The daemon answers: the conversation is shown again with its record, and the covered blocks are the record's.
  letGo()
  const deadline = Date.now() + 5_000
  while (!live.snapshot(id)?.base && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  const read = live.snapshot(id)!
  assert.ok(read.base, "the record was read once the daemon answered")
  assert.equal(read.base.entries.at(-1)?.id, recordEntries.at(-1)!.id)
  assert.equal(read.baseCoveredBlocks, 2)
  assert.ok(emitted.length > 0, "and the window was told")
  const again = await windowRead({ kind: "snapshot" })
  assert.ok(again.base, "the next read has the record")
  console.log(`first page: shown in ${Math.round(waited)} ms with the daemon answering nothing, then with its record once it did`)
} finally {
  await live.stop()
  rmSync(root, { recursive: true, force: true })
}
