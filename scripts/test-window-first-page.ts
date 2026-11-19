import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { SETTLE_WORK } from "@mako/host/conversations/live-sources"
import { namedWork } from "@mako/host/base/event-loop"
import { copiedBaseBytes } from "@mako/host/conversations/live-journal"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveHistoryChunk, LiveHistoryRead, LiveHistorySnapshot } from "@mako/host/contracts/live-history"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// A window opening a long Thread whose history its journal doesn't keep (read back from its session, `baseSource`)
// is answered once the newest page is read, not once every page is read and merged. After an update the host read a
// 15 to 23 thousand entry history page by page from the sync daemon, 13 to 18 s, before the window showed anything
// (2026-11-19). The rest is read meanwhile; once it lands, the conversation's next revision says its history changed.
// Also: the sweep that moves journals' copies onto their sessions' records names itself and waits for the window.
const harness = "test-provider"
const nativeId = "native-1"
const ENTRIES = 20_000
const PAGE = 200
/** What one page costs to ask the catalog for, over the sync daemon's socket: a few ms at rest, far more after an update. */
const PAGE_MS = 3
/** A decode the catalog has no view for: a long session read whole by its new decoder. */
const DECODE_MS = 400

function entry(index: number): Entry {
  const id = `entry-${index}`
  return index % 2 === 0 ? { type: "user", id, text: `Ask ${index}` } : { type: "text", id, text: `Answer ${index} `.repeat(20) }
}

/** The session as the catalog serves it, a page at a time: `stale`, an earlier build's view of it; `views`, this build's. */
class Native {
  readonly entries = Array.from({ length: ENTRIES }, (_, index) => entry(index))
  pages = 0
  /** Held while set: the catalog slow to answer. */
  gate: Promise<void> | undefined
  /** Whether this build's view of the session is at hand; without one its first read decodes it whole. */
  decoded = false
  stale = true
  constructor(readonly path: string, readonly nativeId = "native-1") {}
  private page(before: number | undefined, translator: string): ThreadPage {
    const end = before ?? this.entries.length
    const start = Math.max(0, end - PAGE)
    return {
      ref: { harness, nativeId: this.nativeId, path: this.path, bytes: ENTRIES * 100, title: "A long session", cwd: "/tmp" },
      entries: structuredClone(this.entries.slice(start, end)), start, total: this.entries.length, hasEarlier: start > 0, translator,
    }
  }
  async current(path: string, before?: number): Promise<ThreadPage | null> {
    if (path !== this.path) return null
    await this.gate
    if (!this.decoded) {
      await new Promise((resolve) => setTimeout(resolve, DECODE_MS))
      this.decoded = true
    }
    this.pages += 1
    await new Promise((resolve) => setTimeout(resolve, PAGE_MS))
    return this.page(before, "build-2")
  }
  async earlier(path: string, before?: number): Promise<ThreadPage | null> {
    if (path !== this.path || !this.stale) return null
    this.pages += 1
    await new Promise((resolve) => setTimeout(resolve, PAGE_MS))
    return this.page(before, "build-1")
  }
}

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
  start: async (id) => ({ id, nativeId, nativePath: "/tmp/none", harness, cwd: "/tmp", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }),
  prompt: async () => {},
  permission: async () => {},
  cancel: async () => {},
  close: () => {},
  setMode: async () => {},
}

/** A history read whole, its parts joined, as a window reads one. */
async function readWhole(reader: LiveHistoryReader, id: string, input: LiveHistoryRead, snapshot: () => Promise<LiveSnapshot | null>): Promise<LiveSnapshot> {
  let part: LiveHistoryChunk = await reader.read(id, input, snapshot)
  const pieces = [part.data]
  while (part.next !== null) {
    part = await reader.read(id, { kind: "part", record: part.record, offset: part.next }, snapshot)
    pieces.push(part.data)
  }
  // SAFETY: a history read's parts are the JSON of the typed value the reader answered: a snapshot read's, a snapshot.
  const read = JSON.parse(pieces.join("")) as LiveHistorySnapshot
  if (!read || "kind" in read) throw new Error("the read answered no snapshot")
  return read
}

const root = mkdtempSync(join(tmpdir(), "mako-window-first-page-"))
const hosts: LiveConversations[] = []
try {
  const path = join(root, "session.jsonl")
  writeFileSync(path, "")
  const native = new Native(path)
  const natives = new Map([[path, native]])
  const events: HostEvent[] = []
  const work = namedWork()
  let holding = true
  let budget: { bytes: number; recent: number; sweepMs: number } | undefined
  const host = () => {
    let shownBy: LiveHistoryReader | undefined
    const live: LiveConversations = new LiveConversations({
      ...budget && { conversationMemory: budget },
      historyShown: (id) => shownBy?.shown(id) ?? false,
      appPath: root, root: join(root, "conversations"), driver: () => driver, emit: (event) => events.push(event),
      history: async (at, before) => (await natives.get(at)?.current(at, before)) ?? null,
      staleHistory: async (at, before) => (await natives.get(at)?.earlier(at, before)) ?? null,
      holdHistory: async () => holding,
      nativePath: (identity) => [...natives.values()].find((each) => each.nativeId === identity.nativeId)?.path,
      resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
      work,
    })
    hosts.push(live)
    const reader = new LiveHistoryReader((at, before) => native.current(at, before), undefined, undefined, (id) => live.held(id))
    shownBy = reader
    return { live, reader }
  }
  const waitFor = async (predicate: () => boolean, message: string, ms = 30_000) => {
    const until = Date.now() + ms
    while (!predicate()) {
      if (Date.now() > until) throw new Error(message)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // Captured, and its copy let go once the record store holds the session.
  const id = randomUUID()
  native.decoded = true
  native.stale = false
  const first = host()
  await first.live.capture(id, path)
  await waitFor(() => Boolean(first.live.snapshot(id)?.baseSource), "the journal names its session once it's held")
  await first.live.stop()

  /** A window opening the conversation on a new host, the way `mako:live-read` reads it, and how long it waited. */
  const open = async (read: (live: LiveConversations) => (id: string) => Promise<LiveSnapshot | null>) => {
    const { live, reader } = host()
    native.pages = 0
    const started = performance.now()
    // Named as the host names a window's read.
    const snapshot = await work.run("mako:live-read", () => readWhole(reader, id, { kind: "snapshot" }, () => read(live)(id)))
    const ms = performance.now() - started
    return { live, reader, ms, pages: native.pages, snapshot }
  }

  // An update changed the decoder; the record didn't, so an earlier build's view of it is at hand.
  native.decoded = false
  native.stale = true
  const whole = await open((live) => (id) => live.refreshedSnapshot(id))
  assert.equal(whole.snapshot.base?.total, ENTRIES)
  await whole.live.stop()
  native.decoded = false
  const shown = await open((live) => (id) => live.windowSnapshot(id))
  const base = shown.snapshot.base!
  assert.equal(base.start + base.entries.length, ENTRIES, "the window is answered with the history's newest entries")
  assert.ok(base.hasEarlier && base.start > 0, "the rest is read back as the window pages back")
  assert.equal(base.entries.at(-1)?.id, `entry-${ENTRIES - 1}`)
  assert.ok(shown.ms * 4 < whole.ms, `a window opening it waits for its newest page (${Math.round(shown.ms)} ms), not the whole history (${Math.round(whole.ms)} ms)`)
  // Paging back from what was shown reads the session's earlier page while the rest is read.
  const earlier = await shown.reader.read(id, { kind: "earlier", token: shown.snapshot.history!.token, before: shown.snapshot.history!.before! }, () => shown.live.windowSnapshot(id))
  assert.ok(earlier.data.length > 0)
  // The whole history lands, and the window hears its history changed, so it reads it again.
  const revision = shown.snapshot.revision
  await waitFor(() => (shown.live.held(id)?.base?.entries.length ?? 0) === ENTRIES, "the whole history is read meanwhile")
  await waitFor(() => events.some((event) => event.type === "live-batch" && event.batch.id === id && event.batch.revision > revision && (event.batch.historyChanged || event.batch.base !== undefined)), "its next revision says the history changed")
  const reread = await readWhole(shown.reader, id, { kind: "snapshot" }, () => shown.live.windowSnapshot(id))
  assert.ok(reread.revision > revision && reread.base?.total === ENTRIES, "read again, it's the new revision")
  console.log(`window first page with an earlier build's view: ${Math.round(shown.ms)} ms (${shown.pages} pages asked) vs the whole history first: ${Math.round(whole.ms)} ms (${whole.pages} pages)`)
  await shown.live.stop()

  // No view of it at all (the record changed too): the newest page waits for the decode, but not for every page.
  native.decoded = false
  native.stale = false
  const decoded = await open((live) => (id) => live.refreshedSnapshot(id))
  await decoded.live.stop()
  native.decoded = false
  const decodedFirst = await open((live) => (id) => live.windowSnapshot(id))
  assert.ok(decodedFirst.ms < decoded.ms / 2, `decoded first, the window waits for the decode and one page (${Math.round(decodedFirst.ms)} ms), not every page (${Math.round(decoded.ms)} ms)`)
  console.log(`window first page with no view: ${Math.round(decodedFirst.ms)} ms vs the whole history first: ${Math.round(decoded.ms)} ms`)
  await waitFor(() => (decodedFirst.live.held(id)?.base?.entries.length ?? 0) === ENTRIES, "the whole history is read meanwhile")

  // The sweep moving journals' copies onto their records names what it reads in, and waits while a window reads.
  holding = false
  const kept = randomUUID()
  const copied = join(root, "copied.jsonl")
  writeFileSync(copied, "")
  const other = new Native(copied, "native-2")
  other.decoded = true
  other.stale = false
  natives.set(copied, other)
  native.decoded = true
  const sweepHost = host()
  hosts.push(sweepHost.live)
  await sweepHost.live.capture(kept, copied)
  assert.ok(copiedBaseBytes(join(root, "conversations"), kept) > 0, "a journal the record store didn't take keeps its copy")
  assert.ok(sweepHost.live.letGo(kept), "and is let go")
  let release!: () => void
  native.gate = new Promise((resolve) => { release = resolve })
  const reading = work.run("mako:live-read", () => sweepHost.live.windowSnapshot(id))
  const settling = sweepHost.live.settleHistoryCopies(0)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(!sweepHost.live.held(kept), "the sweep reads nothing in while a window reads")
  release()
  native.gate = undefined
  await reading
  const report = await settling
  assert.equal(report.copies, 1)
  const loads = sweepHost.live.residency().memory.loads.map((load) => load.by)
  assert.ok(loads.includes(SETTLE_WORK), `what the sweep reads in is counted to it: ${loads.join(", ")}`)
  assert.ok(!loads.includes("unnamed work"), `every load is named: ${loads.join(", ")}`)

  // A conversation a window shows stays in memory however tight the budget: let go, its next read starts over.
  budget = { bytes: 1, recent: 0, sweepMs: 1 }
  const tight = host()
  await work.run("mako:live-read", () => tight.reader.read(id, { kind: "snapshot" }, () => tight.live.windowSnapshot(id)))
  await waitFor(() => (tight.live.held(id)?.base?.entries.length ?? 0) === ENTRIES, "the whole history is read")
  assert.ok(tight.reader.shown(id), "a window shows it")
  assert.ok(tight.live.snapshot(kept), "another is read in")
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(tight.live.held(id), "the one shown stays")
  assert.ok(!tight.live.held(kept), "the one nothing shows goes")
} finally {
  for (const live of hosts) await live.stop().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}
console.log("window first page: the newest page first, the rest read meanwhile")
