import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { LiveUpdate } from "@mako/sessions/live-content"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { WARM_CHARS } from "@mako/host/conversations/live-records"
import { isPaged, pagedWeight } from "@mako/host/conversations/paged-entries"
import { ContentWeights } from "@mako/host/contracts/residency"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// A conversation's finished entries are paged: memory holds a copy whose long
// fields are read back from the journal's row (`paged-entries.ts`). Paged,
// an entry reads, serialises, spreads and compares as it did; a row written
// over or dropped never changes an entry paged from it; a closed journal's
// paged entries still read; and the host pages a conversation whose harness
// is running, all but its turn under way.

const harness = "test-provider"
const root = mkdtempSync(join(tmpdir(), "mako-paged-entries-"))
const long = (seed: string, chars = 4_000) => `${seed} — “${"history ".repeat(Math.ceil(chars / 8))}”`.slice(0, chars)
const waitFor = async (predicate: () => boolean, message: string, ms = 10_000) => {
  const until = Date.now() + ms
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function snapshotOf(id: string, blocks: Entry[], base: ThreadPage | null = null): LiveSnapshot {
  return {
    session: { id, harness, cwd: "/tmp", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: 1, base, blocks, permissions: [], requests: [],
  }
}

try {
  // An entry paged is the entry: its fields, JSON, a spread and deep equality are what they were.
  {
    const id = randomUUID()
    const journal = new LiveJournal(join(root, "transparent"), id)
    const tool: Entry = { type: "tool", id: "call-1", name: "Bash", status: "completed", input: JSON.stringify({ command: "ls" }), output: long("output") }
    const text: Entry = { type: "text", id: "text-1", text: long("reply") }
    const blocks: Entry[] = [{ type: "user", id: "user-1", text: "Short ask" }, tool, text]
    const snapshot = snapshotOf(id, blocks)
    journal.commit(snapshot)
    const warm = structuredClone(blocks)
    journal.pageBlocks(blocks, 0, blocks.length, Infinity)
    assert.equal(isPaged(blocks[0]!), false, "an entry with nothing long stays as it is")
    assert.ok(isPaged(blocks[1]!) && isPaged(blocks[2]!), "entries with long fields are paged")
    assert.equal(JSON.stringify(blocks), JSON.stringify(warm), "JSON is the same, field for field and in order")
    assert.deepEqual({ ...blocks[1]! }, warm[1], "a spread reads every field back")
    assert.ok(isDeepStrictEqual(blocks[2], warm[2]), "deep equality holds")
    assert.deepEqual(Object.keys(blocks[1]!), Object.keys(warm[1]!))
    const call = blocks[1]!
    const warmCall = warm[1]!
    assert.ok(call.type === "tool" && warmCall.type === "tool" && call.output === warmCall.output)
    const weights = new ContentWeights(pagedWeight)
    assert.ok(weights.of({ blocks: blocks.slice(1) }) < 2_000, "a paged entry weighs what memory keeps of it, not its row")
    // A write gives the entry its own value, as on any other entry.
    const paged = blocks[2]!
    if (paged.type === "text") paged.text = "rewritten"
    assert.ok(paged.type === "text" && paged.text === "rewritten")
    journal.close()
  }

  // A row written over, cut off or appended to gives the entry paged from it its content first.
  {
    const id = randomUUID()
    const journal = new LiveJournal(join(root, "rewritten"), id)
    const first: Entry[] = [{ type: "user", id: "user-1", text: long("ask") }, { type: "text", id: "text-1", text: long("first reply") }, { type: "text", id: "text-2", text: long("second reply") }]
    const before = snapshotOf(id, first)
    journal.commit(before)
    journal.pageBlocks(first, 0, first.length, Infinity)
    const held = [...first]
    const view = JSON.stringify(held)
    const next: Entry[] = [first[0]!, { type: "text", id: "text-1", text: long("another reply") }]
    const after = { ...before, revision: 2, blocks: next }
    journal.commit(after, before)
    assert.equal(JSON.stringify(held), view, "what an earlier revision holds still reads as it was, though row 1 changed and row 2 went")
    assert.equal(isPaged(held[1]!), false, "the entry row 1 held took its content back")
    assert.ok(isPaged(held[0]!), "an entry whose row didn't change stays paged")
    journal.close()
    const reopened = new LiveJournal(join(root, "rewritten"), id)
    assert.deepEqual(reopened.read()!.blocks, next, "the journal holds the new revision")
    reopened.close()
  }

  // A history's entries are paged once their row holds them, and a closed journal's paged entries still read.
  {
    const id = randomUUID()
    const folder = join(root, "base")
    const journal = new LiveJournal(folder, id)
    const page: ThreadPage = {
      ref: { harness, nativeId: "native-1", path: join(root, "session.jsonl"), title: "A session", cwd: "/tmp" },
      entries: Array.from({ length: 6 }, (_, index): Entry => index % 2 ? { type: "text", id: `entry-${index}`, text: long(`entry ${index}`) } : { type: "user", id: `entry-${index}`, text: long(`ask ${index}`) }),
      start: 0, total: 6, hasEarlier: false,
    }
    const snapshot = snapshotOf(id, [], page)
    journal.commit(snapshot)
    const warm = JSON.stringify(page.entries)
    journal.pageBase(page.entries, 0, page.entries.length, Infinity)
    assert.ok(page.entries.every(isPaged), "every entry the rows hold is paged")
    journal.close()
    assert.equal(JSON.stringify(page.entries), warm, "a closed journal's paged entries read through a connection of their own")
  }

  // The host pages a conversation while its harness runs: everything but its turn under way and its newest entries.
  {
    const id = randomUUID()
    let emit: ((event: Parameters<NonNullable<Parameters<ProviderLiveDriver["start"]>[1]["emit"]>>[0]) => void) | undefined
    const state = (status: LiveSessionState["status"]): LiveSessionState => ({
      id, nativeId: "native-1", nativePath: join(root, "native"), harness, cwd: root, status, connection: "connected", modes: [], currentMode: null, configOptions: [],
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
      start: async (_cwd, options) => {
        emit = options.emit
        return state("ready")
      },
      prompt: async (_binding, _text, _attachments, _settings, dispatch) => {
        dispatch.report({ kind: "submitted", source: "transport-call" })
        emit!({ type: "live-session", session: state("running") })
      },
      permission: async () => {}, cancel: async () => {}, close: () => {}, setMode: async () => {},
    }
    let reader!: LiveHistoryReader
    const live = new LiveConversations({
      appPath: root, root: join(root, "host"), driver: () => driver, emit: () => {},
      history: async () => null,
      historyPaged: (paged) => reader.paged(paged),
      historyReleased: (released) => reader.released(released),
      conversationMemory: { bytes: 128 * 1024 * 1024, recent: 2, sweepMs: 20 },
      resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    })
    reader = new LiveHistoryReader(undefined, undefined, undefined, (held) => live.held(held))
    try {
      await live.start(harness, root, { conversationId: id })
      // Three turns, each far more than the conversation keeps warm; the last still running.
      for (let turn = 0; turn < 3; turn++) {
        live.submit(id, randomUUID(), `Turn ${turn}`)
        await waitFor(() => live.held(id)?.session.status === "running" && live.held(id)!.requests.at(-1)?.status === "dispatching", `turn ${turn} runs`)
        const updates: LiveUpdate[] = []
        for (let call = 0; call < 12; call++)
          updates.push({ kind: "tool", id: `call-${turn}-${call}`, title: "Bash", status: "completed", input: "{}", output: long(`turn ${turn} call ${call}`, 40_000) })
        emit!({ type: "live-updates", id, updates })
        if (turn < 2) {
          emit!({ type: "live-session", session: state("ready") })
          await waitFor(() => live.held(id)?.requests.at(-1)?.status === "completed", `turn ${turn} ends`)
        }
      }
      const window = await reader.read(id, { kind: "snapshot" }, async () => live.snapshot(id))
      assert.ok(window.data.length > 0)
      const warm = JSON.stringify(live.held(id)!.blocks)
      assert.ok(warm.length > WARM_CHARS * 4, "the conversation holds far more than it keeps warm")
      await waitFor(() => live.held(id)!.blocks.some(isPaged), "the sweep pages a running conversation")
      const blocks = live.held(id)!.blocks
      assert.equal(live.held(id)!.session.status, "running", "it is still running")
      let turnStart = blocks.length - 1
      while (blocks[turnStart]!.type !== "user") turnStart--
      assert.ok(blocks.slice(turnStart).every((block) => !isPaged(block)), "the turn under way stays in memory")
      assert.ok(blocks.slice(0, turnStart).every((block) => isPaged(block) || block.type === "user"), "earlier turns are paged")
      assert.equal(JSON.stringify(blocks), warm, "paged, the conversation reads as it did")
      const memory = live.residency().memory
      assert.ok(memory.bytes < warm.length, `memory weighs ${memory.bytes} bytes of ${warm.length} characters held before`)
      // The window's view of an earlier revision holds the paged entries too.
      const views = reader.viewsOf(id)
      assert.ok(views.length > 0 && views.every((view) => view.blocks.slice(0, turnStart).every((block) => isPaged(block) || block.type === "user")))
      // The turn goes on: a call of it grows, and the ones paged before stay as they were.
      emit!({ type: "live-update", id, update: { kind: "tool-update", id: "call-2-11", outputAppend: " and more" } })
      await waitFor(() => JSON.stringify(live.snapshot(id)!.blocks).includes(" and more"), "the running call grows")
      assert.equal(JSON.stringify(live.snapshot(id)!.blocks.slice(0, turnStart)), JSON.stringify(JSON.parse(warm).slice(0, turnStart)))
    } finally {
      await live.stop()
    }
  }

  console.log("PASS: paged entries read as they were, survive their rows changing and their journal closing, and a running conversation keeps only its turn under way")
} finally {
  rmSync(root, { recursive: true, force: true })
}
