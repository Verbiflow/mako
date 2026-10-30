import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getHeapStatistics } from "node:v8"
import type { ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// Reading a conversation whose history is hundreds of megabytes, as the host
// does after each turn: the window asks for it (`mako:live-read`), the host
// reads the session again, keeps what it adds, and the journal lets its copy
// go once the record store holds the session; the next turn makes it keep
// one again. Each step must leave the event loop free within a slice
// (`MAX_HOLD_MS`), and the turns read must not leave a copy of the history
// held per turn.
//
//   npm run bench:live-read -- [--mb 60] [--turns 3]
//
// Before entries kept their objects across readings, each read here held
// the loop for 250ms at 60MB and 700ms at 157MB, and a turn's start 180ms
// and 630ms: the journal wrote the whole history as one row, twice a turn.
// On a copy of a real 157MB journal that write alone took 1.9s.

const argument = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? Number(process.argv[at + 1]) : fallback
}
const MEGABYTES = argument("mb", 60)
const TURNS = argument("turns", 3)
/** The longest the loop may be held by any one step; well past a slice (8ms), well under what a person notices. */
const MAX_HOLD_MS = 100
const harness = "test-provider"
const nativeId = "native-1"
const PAGE_ENTRIES = 200
/** About what an entry of a long Claude Code session weighs: 157MB over 22,291 entries. */
const ENTRY_CHARS = 7_000

// SAFETY: `--expose-gc` puts `gc` on the global object; the assertion below says when it wasn't given.
const gc = (globalThis as { gc?: () => void }).gc
assert.ok(gc, "run with --expose-gc")
const heapMB = () => {
  gc()
  gc()
  return process.memoryUsage().heapUsed / 1_048_576
}

/** The longest the loop went without turning, sampled every few milliseconds while `watch` runs. */
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
  // What the step left to run after it answered (the hold, rows written ahead) counts as the step's.
  await new Promise((resolve) => setTimeout(resolve, 200))
  running = false
  return { value, maxHoldMs: Math.max(maxHoldMs, performance.now() - last), ms, peakMB: peak / 1_048_576 }
}

let seed = 0
/** Words as an agent writes them, a typographic dash and quote among them, so the strings are two-byte as real ones are. */
const WORDS = "the host reads conversation again — keeps what it adds; “history” holds turns: tool output, paths, diffs, 42 lines".split(" ")
function prose(index: number, chars: number): string {
  const parts: string[] = []
  let length = 0
  for (let at = index; length < chars; at = (at * 1_103_515_245 + 12_345) % 2_147_483_648) {
    const word = WORDS[at % WORDS.length]!
    parts.push(word)
    length += word.length + 1
  }
  return parts.join(" ").slice(0, chars)
}
function entry(index: number): Entry {
  const text = prose(index, ENTRY_CHARS)
  const id = `entry-${index}`
  if (index % 4 === 0) return { type: "user", id, text: text.slice(0, 400) }
  if (index % 4 === 1) return { type: "text", id, text }
  if (index % 4 === 2) return { type: "tool", id, name: "Bash", status: "completed", input: JSON.stringify({ command: `ls ${index}` }), output: text }
  return { type: "thinking", id, text: text.slice(0, 2_000) }
}

/** The session as its harness has it: read again, every entry is a new object, a page at a time, as the catalog answers. */
class Native {
  entries: Entry[] = []
  bytes = 0
  constructor(readonly path: string) {}
  grow(count: number): void {
    for (let index = 0; index < count; index++) this.entries.push(entry(seed++))
    this.bytes += count * ENTRY_CHARS
  }
  page(before?: number): ThreadPage {
    const end = before ?? this.entries.length
    const start = Math.max(0, end - PAGE_ENTRIES)
    return {
      ref: { harness, nativeId, path: this.path, bytes: this.bytes, title: "A long session", cwd: "/tmp" },
      entries: structuredClone(this.entries.slice(start, end)),
      start, total: this.entries.length, hasEarlier: start > 0, translator: "bench",
    }
  }
}

function host(root: string, native: Native) {
  const driver: ProviderLiveDriver = {
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
    provider: harness,
    available: () => true,
    start: async (id) => ({ id, nativeId, nativePath: native.path, harness, cwd: "/tmp", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }),
    prompt: async () => {},
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  const page = async (path: string, before?: number) => {
    // An answer from another process arrives on a later turn of the loop.
    await new Promise((resolve) => setImmediate(resolve))
    return path === native.path ? native.page(before) : null
  }
  const live: LiveConversations = new LiveConversations({
    appPath: root,
    root: join(root, "conversations"),
    driver: () => driver,
    emit: () => {},
    history: page,
    holdHistory: async () => true,
    nativePath: (identity) => (identity.nativeId === nativeId ? native.path : undefined),
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  const reader = new LiveHistoryReader(page, undefined, undefined, (id) => live.held(id))
  return { live, reader }
}

const root = mkdtempSync(join(tmpdir(), "mako-bench-live-read-"))
const path = join(root, "session.jsonl")
writeFileSync(path, "")
const results = new Map([["historyMB", MEGABYTES]])
try {
  const baseline = heapMB()
  const native = new Native(path)
  native.grow(Math.round((MEGABYTES * 1_048_576) / ENTRY_CHARS))
  const nativeMB = heapMB() - baseline
  const id = randomUUID()
  const { live, reader } = host(root, native)
  const held = async () => {
    const started = Date.now()
    while (!live.snapshot(id)?.baseSource) {
      if (Date.now() - started > 120_000) throw new Error("the record store never took the history")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const captured = await watch(async () => {
    await live.capture(id, path)
    await held()
  })
  results.set("captureMaxHoldMs", Math.round(captured.maxHoldMs))

  // Each turn: the session gains a turn, the window reads the conversation, the host reads the session again.
  let worstRead = 0
  let readPeak = 0
  const settled = heapMB()
  for (let turn = 0; turn < TURNS; turn++) {
    native.grow(6)
    const read = await watch(async () => {
      const chunk = await reader.read(id, { kind: "snapshot" }, () => live.refreshedSnapshot(id))
      assert.ok(chunk.data.length > 0)
      await held()
    })
    assert.equal(live.snapshot(id)!.base!.entries.length, native.entries.length, "the read keeps the turn the session gained")
    worstRead = Math.max(worstRead, read.maxHoldMs)
    readPeak = Math.max(readPeak, read.peakMB)
    results.set(`read${turn + 1}Ms`, Math.round(read.ms))
    results.set(`read${turn + 1}MaxHoldMs`, Math.round(read.maxHoldMs))
  }

  // The next turn begins: Mako's live blocks pass what the session covers, and the journal keeps its copy again.
  const journal = new LiveJournal(join(root, "conversations-flip"), id)
  const before = live.snapshot(id)!
  const covered: LiveSnapshot = before
  journal.commit(covered)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const staged = await watch(async () => {
    // Rows written ahead of the turn, a slice at a time.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  })
  const running: LiveSnapshot = { ...covered, revision: covered.revision + 1, blocks: [{ type: "user", text: "the next ask" }] }
  const flip = performance.now()
  journal.commit(running, covered)
  const turnStartMs = performance.now() - flip
  results.set("turnStartCommitMs", Math.round(turnStartMs))
  results.set("writeAheadMaxHoldMs", Math.round(staged.maxHoldMs))
  const load = performance.now()
  const reread = new LiveJournal(join(root, "conversations-flip"), id).read()!
  results.set("journalLoadMs", Math.round(performance.now() - load))
  assert.equal(reread.base?.entries.length, native.entries.length, "the copy the turn keeps reads back whole")
  journal.close()

  const retained = heapMB() - baseline - nativeMB
  results.set("historyHeapMB", Math.round(nativeMB))
  // How far above the heap the conversation settled at a read takes it: what it builds and drops while reading.
  results.set("readPeakAboveSettledMB", Math.round(readPeak - settled))
  results.set("retainedMB", Math.round(retained))
  results.set("worstReadMaxHoldMs", Math.round(worstRead))
  console.log(JSON.stringify(Object.fromEntries(results), null, 2))
  await live.stop()
  assert.ok(worstRead <= MAX_HOLD_MS, `a read held the loop ${Math.round(worstRead)}ms; at most ${MAX_HOLD_MS}ms`)
  assert.ok(turnStartMs <= MAX_HOLD_MS, `a turn's start held the loop ${Math.round(turnStartMs)}ms writing the history; at most ${MAX_HOLD_MS}ms`)
  assert.ok(staged.maxHoldMs <= MAX_HOLD_MS, `writing the history ahead held the loop ${Math.round(staged.maxHoldMs)}ms`)
  // The history once, as the conversation holds it, and what the reader's views and the record keep beside it; not a
  // copy per turn read. `nativeMB` is one copy of it on this heap: the session as the harness's store has it.
  assert.ok(retained <= nativeMB * 1.5, `${Math.round(retained)}MB held for a history that is ${Math.round(nativeMB)}MB on the heap`)
  assert.ok(captured.maxHoldMs <= MAX_HOLD_MS, `taking the session in held the loop ${Math.round(captured.maxHoldMs)}ms; at most ${MAX_HOLD_MS}ms`)
  console.log("PASS: a huge conversation is read, refreshed and kept without holding the event loop")
} finally {
  rmSync(root, { recursive: true, force: true })
}
