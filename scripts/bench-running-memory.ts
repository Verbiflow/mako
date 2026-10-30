import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getHeapStatistics } from "node:v8"
import type { ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { LiveUpdate } from "@mako/sessions/live-content"
import { followHostLog } from "@mako/host/base/host-log"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { CONVERSATION_MEMORY } from "@mako/host/conversations/live-records"
import { ContentWeights } from "@mako/host/contracts/residency"
import { isPaged, pagedWeight } from "@mako/host/conversations/paged-entries"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveHistoryChunk, LiveHistoryCursor } from "@mako/host/contracts/live-history"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// What the host keeps of a huge conversation whose harness is attached and
// running, shaped like the one that held 422MB on 2026-10-30: its history
// read from its session's records (`baseSource`), every one of Mako's live
// blocks covered by it, a turn streaming. After each phase, once the host's
// sweep has run, the conversation must keep under `MAX_RETAINED_MB` above
// the heap it started from, whatever its history weighs:
//
// - opened: the journal read, the history read from the session and merged;
// - streaming: a turn running, its calls' output growing;
// - scrolled: a window reading the whole history back, a page at a time;
// - ended: the turn in the record, the session read again and merged;
// - reconnected: a new host, the conversation reopened and running again.
//
// Streaming must also leave the event loop free within `MAX_HOLD_MS`. The
// other phases' longest holds are printed: reading the journal, merging the
// session with Mako's blocks, and measuring a journal's copy for the sweep
// that moves copies onto records (which lands among the window's reads)
// each still run in one stretch.
//
//   npm run bench:running-memory -- [--mb 150] [--account] [--log]
//
// `--account` prints what holds the history, by structure, after each phase;
// `--log`, the host's log. Before paging (`paged-entries.ts`) the host kept
// about three times the history in every phase: 123MB at 40MB.

const argument = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? Number(process.argv[at + 1]) : fallback
}
const MEGABYTES = argument("mb", 60)
const ACCOUNT = process.argv.includes("--account")
/**
 * What one conversation may keep beyond the heap it began with: its turn under way, its newest entries, about
 * 300 bytes an entry of the rest (85,000 at 150MB), and the history reader's last reads (32MB at most).
 */
const MAX_RETAINED_MB = argument("max-retained", 72)
/** The longest streaming may hold the loop. */
const MAX_HOLD_MS = argument("max-hold", 50)
const harness = "test-provider"
const nativeId = "native-1"
const PAGE_ENTRIES = 100
/** A turn as a long agent session has them: a prompt, thinking, calls whose output is most of the bytes, replies. */
const TURN = ["user", "thinking", "tool", "text", "thinking", "tool", "tool", "text"] as const
/** About what a call's output in such a session weighs. */
const OUTPUT_CHARS = 9_000
/** The stream carries a call's output as it ran; the record keeps it whole. */
const STREAMED_SHARE = 0.4

// SAFETY: `--expose-gc` puts `gc` on the global object; the assertion below says when it wasn't given.
const gc = (globalThis as { gc?: () => void }).gc
assert.ok(gc, "run with --expose-gc")
const heapMB = () => {
  gc()
  gc()
  return process.memoryUsage().heapUsed / 1_048_576
}

/** The longest the loop went without turning, sampled every few milliseconds while `work` runs. */
async function watch<Value>(work: () => Promise<Value>): Promise<{ value: Value; maxHoldMs: number; ms: number; peakMB: number }> {
  let maxHoldMs = 0
  let peak = 0
  let last = performance.now()
  let running = true
  const tick = () => {
    const now = performance.now()
    maxHoldMs = Math.max(maxHoldMs, now - last)
    peak = Math.max(peak, getHeapStatistics().used_heap_size)
    last = now
    if (running) setTimeout(tick, 2)
  }
  setTimeout(tick, 2)
  const started = performance.now()
  const value = await work()
  const ms = performance.now() - started
  await new Promise((resolve) => setTimeout(resolve, 200))
  running = false
  return { value, maxHoldMs: Math.max(maxHoldMs, performance.now() - last), ms, peakMB: peak / 1_048_576 }
}

const WORDS = "the host reads conversation again — keeps what it adds; “history” holds turns: tool output, paths, diffs, 42 lines".split(" ")
function prose(index: number, chars: number): string {
  const parts: string[] = []
  let length = 0
  for (let at = index + 1; length < chars; at = (at * 1_103_515_245 + 12_345) % 2_147_483_648) {
    const word = WORDS[at % WORDS.length]!
    parts.push(word)
    length += word.length + 1
  }
  return parts.join(" ").slice(0, chars)
}

/** Entry `index` of the session as its record keeps it, made again on each read, as a decoder reading a view does. */
function recorded(index: number): Entry {
  const kind = TURN[index % TURN.length]!
  const id = `entry-${index}`
  if (kind === "user") return { type: "user", id, text: `Ask ${index}: ${prose(index, 300)}` }
  if (kind === "thinking") return { type: "thinking", id, text: prose(index, 500) }
  if (kind === "text") return { type: "text", id, text: prose(index, 600) }
  return { type: "tool", id: `call-${index}`, name: "Bash", status: "completed", input: JSON.stringify({ command: `ls ${index}` }), output: prose(index, OUTPUT_CHARS) }
}

/** The same entry as Mako's stream had it: the prompt with its request, a call's output as far as it streamed. */
function streamed(index: number): Entry {
  const entry = recorded(index)
  if (entry.type === "user") return { ...entry, requestId: requestIdOf(Math.floor(index / TURN.length)) }
  if (entry.type === "tool") return { ...entry, output: entry.output?.slice(0, Math.round(OUTPUT_CHARS * STREAMED_SHARE)) }
  return entry
}

function requestIdOf(turn: number): string {
  return `00000000-0000-4000-8000-${turn.toString(16).padStart(12, "0")}`
}

const entryChars = TURN.reduce((sum, kind) => sum + (kind === "tool" ? OUTPUT_CHARS : kind === "user" ? 310 : kind === "text" ? 600 : 500), 0) / TURN.length
const ENTRIES = Math.round(Math.round((MEGABYTES * 1_048_576) / entryChars) / TURN.length) * TURN.length

/** The session's record, read a page at a time as the catalog serves it; it grows as the running turn lands. */
class Native {
  length = ENTRIES
  extra: Entry[] = []
  constructor(readonly path: string) {}
  page(before?: number): ThreadPage {
    const end = before ?? this.length
    const start = Math.max(0, end - PAGE_ENTRIES)
    const entries: Entry[] = []
    for (let index = start; index < end; index++) entries.push(index < ENTRIES ? recorded(index) : structuredClone(this.extra[index - ENTRIES]!))
    return {
      ref: { harness, nativeId, path: this.path, bytes: this.length * entryChars, title: "A long session", cwd: "/tmp" },
      entries, start, total: this.length, hasEarlier: start > 0, translator: "bench",
    }
  }
}

/** The journal a host left: every live block written, the history named by its session rather than copied. */
function writeJournal(root: string, id: string, path: string): void {
  const blocks: Entry[] = []
  for (let index = 0; index < ENTRIES; index++) blocks.push(streamed(index))
  const turns = ENTRIES / TURN.length
  const requests: LiveSnapshot["requests"] = Array.from({ length: turns }, (_, turn) => ({
    id: requestIdOf(turn), text: `Ask ${turn * TURN.length}`, attachments: [], status: "completed", createdAt: 1,
  }))
  const snapshot: LiveSnapshot = {
    session: { id, harness, nativeId, cwd: "/tmp", title: "A long session", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: 1, threadPath: path, base: null,
    baseSource: { harness, nativeId, path }, baseCoveredBlocks: blocks.length, baseLiveStart: 0,
    blocks, permissions: [], requests,
    control: {
      merges: [], activeBindingId: id, transfers: [],
      bindings: [{ id, provider: harness, nativeId, path, coveredBlocks: blocks.length, includesBase: true }],
    },
  }
  const journal = new LiveJournal(root, id)
  journal.commit(snapshot)
  journal.close()
}

interface Turn {
  /** Streams `count` updates into the running turn. */
  stream(count: number): void
  /** Ends the turn, its record holding `recorded`. */
  finish(recorded: Entry[]): void
}

function host(root: string, native: Native, turns: Turn[]) {
  const emits = new Map<string, (event: Parameters<NonNullable<Parameters<ProviderLiveDriver["start"]>[1]["emit"]>>[0]) => void>()
  const session = (bindingId: string, status: LiveSessionState["status"], nativeRunId?: string): LiveSessionState => ({
    id: bindingId, nativeId, nativePath: native.path, harness, cwd: "/tmp", status, connection: "connected", modes: [], currentMode: null, configOptions: [], nativeRunId,
  })
  let run = 0
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
    start: async (_cwd, options) => {
      emits.set(options.conversationId, options.emit!)
      return session(options.conversationId, "ready")
    },
    prompt: async (bindingId, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const emit = emits.get(bindingId)!
      const runId = `run-${run++}`
      emit({ type: "live-session", session: session(bindingId, "running", runId) })
      let call = 0
      let grown = 0
      turns.push({
        stream(count) {
          const updates: LiveUpdate[] = []
          for (let index = 0; index < count; index++) {
            if (grown === 0) updates.push({ kind: "tool", id: `${runId}-call-${call}`, title: "Bash", status: "in_progress", input: "{}" })
            updates.push({ kind: "tool-update", id: `${runId}-call-${call}`, outputAppend: prose(call * 31 + grown, 400) })
            if (++grown === 20) {
              updates.push({ kind: "tool-update", id: `${runId}-call-${call}`, status: "completed" })
              updates.push({ kind: "text", id: `${runId}-text-${call}`, text: prose(call, 300) })
              call++
              grown = 0
            }
          }
          emit({ type: "live-updates", id: bindingId, updates })
        },
        finish(recorded) {
          native.extra.push(...recorded)
          native.length += recorded.length
          emit({ type: "live-session", session: session(bindingId, "ready") })
        },
      })
    },
    permission: async () => {}, cancel: async () => {}, close: () => {}, setMode: async () => {},
  }
  const page = async (path: string, before?: number) => {
    await new Promise((resolve) => setImmediate(resolve))
    return path === native.path ? native.page(before) : null
  }
  const live: LiveConversations = new LiveConversations({
    appPath: root,
    root: join(root, "conversations"),
    driver: () => driver,
    emit: () => {},
    history: page,
    historyPaged: (id) => reader.paged(id),
    historyReleased: (id) => reader.released(id),
    holdHistory: async () => true,
    nativePath: (identity) => (identity.nativeId === nativeId ? native.path : undefined),
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    // Where the session's record stands: a turn that ended is in it, so the host takes the blocks it covers.
    checkpoint: async () => String(native.length),
  })
  const reader = new LiveHistoryReader(page, undefined, undefined, (id) => live.held(id))
  return { live, reader }
}

/** Long enough for the host's sweep, which pages what a conversation is done with, to have run and finished. */
const SETTLE_MS = CONVERSATION_MEMORY.sweepMs + 5_000

const waitFor = async (check: () => boolean, what: string, ms = 120_000) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A whole chunked read, parsed. */
async function readValue<Value>(reader: LiveHistoryReader, id: string, first: LiveHistoryChunk): Promise<Value> {
  let text = first.data
  let chunk = first
  while (chunk.next !== null) {
    chunk = await reader.read(id, { kind: "part", record: chunk.record, offset: chunk.next }, async () => null)
    text += chunk.data
  }
  // SAFETY: the reader serialises exactly the value the read names.
  return JSON.parse(text) as Value
}

/** The running turn as its record keeps it: what streamed, without Mako's own marks on it. */
function recordOf(blocks: readonly Entry[]): Entry[] {
  let start = blocks.length - 1
  while (start > 0 && blocks[start]!.type !== "user") start--
  return blocks.slice(start).map((block) => {
    const { stream: _stream, ...entry } = structuredClone(block)
    if (entry.type === "user") delete entry.requestId
    return entry
  })
}

const weights = new ContentWeights(pagedWeight)
/** What holds the history, by structure: each one's weight as memory keeps it, how much of it is paged, and what the reader's views keep beyond it. */
function account(label: string, live: LiveConversations, reader: LiveHistoryReader, id: string): void {
  if (!ACCOUNT) return
  const snapshot = live.held(id)
  if (!snapshot) return
  const entries = snapshot.base?.entries ?? []
  const own = new Set<Entry>([...snapshot.blocks, ...entries])
  const views = reader.viewsOf(id)
  let viewOnly = 0
  for (const view of views) for (const entry of [...view.blocks, ...view.base?.entries ?? []]) if (!own.has(entry)) viewOnly += weights.of({ blocks: [entry] }) - 1024 - 8
  console.log(JSON.stringify({
    phase: label,
    blocks: snapshot.blocks.length, blocksPaged: snapshot.blocks.filter(isPaged).length, blocksMB: mb(weights.of({ blocks: snapshot.blocks })),
    baseEntries: entries.length, basePaged: entries.filter(isPaged).length, baseMB: mb(weights.of({ blocks: [], base: snapshot.base })),
    sharedEntries: entries.filter((entry) => snapshot.blocks.includes(entry)).length,
    views: views.length, viewsBeyondMB: mb(viewOnly), weighedMB: mb(live.residency().memory?.bytes ?? 0),
  }))
}
const mb = (bytes: number) => Math.round(bytes / 1_048_576)

// `--log` prints the host's log as it runs.
if (process.argv.includes("--log")) followHostLog((line) => console.log("host.log", line.level, line.scope, line.message, JSON.stringify(line.fields ?? {}).slice(0, 400)))
const root = mkdtempSync(join(tmpdir(), "mako-bench-running-memory-"))
const path = join(root, "session.jsonl")
writeFileSync(path, "")
const results = new Map<string, number>([["historyMB", MEGABYTES], ["entries", ENTRIES]])
const failures: string[] = []
/** `held`: whether the phase's longest hold of the loop is held to `MAX_HOLD_MS`, or only printed. */
const check = (phase: string, retained: number, hold: number, held = false) => {
  results.set(`${phase}RetainedMB`, Math.round(retained))
  results.set(`${phase}MaxHoldMs`, Math.round(hold))
  if (retained > MAX_RETAINED_MB) failures.push(`${phase}: the conversation keeps ${Math.round(retained)}MB; at most ${MAX_RETAINED_MB}MB`)
  if (held && hold > MAX_HOLD_MS) failures.push(`${phase}: held the loop ${Math.round(hold)}ms; at most ${MAX_HOLD_MS}ms`)
}
try {
  const id = randomUUID()
  const native = new Native(path)
  writeJournal(join(root, "conversations"), id, path)
  const baseline = heapMB()
  const turns: Turn[] = []
  let { live, reader } = host(root, native, turns)

  // Opened: the journal is read, its history read from the session and merged with Mako's blocks, the rows written ahead.
  const opened = await watch(async () => {
    await live.historyReady(id)
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  })
  assert.equal(live.held(id)?.base?.entries.length, ENTRIES, "the whole history is read")
  account("opened", live, reader, id)
  check("opened", heapMB() - baseline, opened.maxHoldMs)

  // Streaming: a turn runs, its calls' output growing in batches as a harness sends them.
  live.submit(id, randomUUID(), "Go on")
  await waitFor(() => live.held(id)?.session.status === "running" && turns.length === 1, "the turn to run")
  const streaming = await watch(async () => {
    for (let batch = 0; batch < 200; batch++) {
      turns[0]!.stream(10)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // The sweep that keeps the conversation to its budget runs between other work.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  })
  assert.equal(live.held(id)?.session.status, "running")
  account("streaming", live, reader, id)
  check("streaming", heapMB() - baseline, streaming.maxHoldMs, true)

  // Scrolled: a window reads the conversation, then every earlier page back to its first prompt.
  let pages = 0
  let firstText: string | undefined
  const scrolled = await watch(async () => {
    const first = await reader.read(id, { kind: "snapshot" }, () => live.refreshedSnapshot(id))
    const snapshot = await readValue<LiveSnapshot>(reader, id, first)
    const token = snapshot.history!.token
    let before: LiveHistoryCursor | null = snapshot.history!.before
    while (before) {
      const chunk = await reader.read(id, { kind: "earlier", token, before }, async () => null)
      const page = await readValue<{ blocks: Entry[]; base: ThreadPage | null; history: { before: LiveHistoryCursor | null } }>(reader, id, chunk)
      const entry = page.base?.entries[0]
      if (entry?.type === "user") firstText = entry.text
      before = page.history.before
      pages++
      await new Promise((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  })
  assert.ok(pages > ENTRIES / 200, `the window read the history back (${pages} pages)`)
  const first = recorded(0)
  assert.equal(firstText, first.type === "user" ? first.text : undefined, "the first prompt reads back whole")
  account("scrolled", live, reader, id)
  check("scrolled", heapMB() - baseline, scrolled.maxHoldMs)
  results.set("scrolledPages", pages)

  // Ended: the turn lands in the session's record, the window reads the conversation again, and the host reads the
  // session again to merge the turn's record with what it streamed.
  turns[0]!.finish(recordOf(live.held(id)!.blocks))
  await waitFor(() => live.held(id)?.session.status === "ready", "the turn to end")
  const ended = await watch(async () => {
    // The window reads the conversation again on the batches the turn's end sends, as its coverage lands.
    await waitFor(() => live.held(id)!.control?.bindings[0]?.coveredBlocks === live.held(id)!.blocks.length, "the turn's coverage")
    const chunk = await reader.read(id, { kind: "snapshot" }, () => live.refreshedSnapshot(id))
    await readValue<LiveSnapshot>(reader, id, chunk)
    await waitFor(() => live.held(id)!.base!.entries.length === native.length, "the session to be read again")
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  })
  assert.equal(live.held(id)!.base!.entries.length, native.length, "the history read again holds the turn")
  account("ended", live, reader, id)
  check("ended", heapMB() - baseline, ended.maxHoldMs)

  // Reconnected: the host goes away, a new one opens the conversation and runs a turn in it.
  await live.stop()
  // The ended turn's hooks hold the stopped host; nothing of it may count against the new one.
  turns.splice(0)
  ;({ live, reader } = host(root, native, turns))
  // The stopped host's last waits (a sweep's pause of 2s) end before it can be collected.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  results.set("stoppedRetainedMB", Math.round(heapMB() - baseline))
  if (process.env.BENCH_HEAP_SNAPSHOT) (await import("node:v8")).writeHeapSnapshot(process.env.BENCH_HEAP_SNAPSHOT)
  const reconnected = await watch(async () => {
    await live.historyReady(id)
    live.submit(id, randomUUID(), "And again")
    await waitFor(() => live.held(id)?.session.status === "running" && turns.length === 1, "the reconnected turn to run")
    for (let batch = 0; batch < 50; batch++) {
      turns[0]!.stream(10)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  })
  account("reconnected", live, reader, id)
  check("reconnected", heapMB() - baseline, reconnected.maxHoldMs)
  const memory = live.residency().memory
  if (memory) results.set("weighedMB", mb(memory.bytes))
  turns[0]!.finish(recordOf(live.held(id)!.blocks))
  await live.stop()
  console.log(JSON.stringify(Object.fromEntries(results), null, 2))
  assert.deepEqual(failures, [], failures.join("\n"))
  console.log("PASS: a huge running conversation stays within its memory, and its streaming never holds the loop")
} finally {
  rmSync(root, { recursive: true, force: true })
}
