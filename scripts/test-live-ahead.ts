/**
 * A conversation's text at two paces from one batch stream (`LiveConversations.schedule`, `LiveAhead`): this machine's
 * windows hear what waits for the next batch every paint frame, and the batches themselves, which the journal, the
 * gateway's link and every watching device get, go exactly as they did. Held here against the pacing as it was before
 * windows heard anything ahead (`before`, kept below), on a clock the test turns.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/test-live-ahead.ts
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { request, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { LIVE_AHEAD_MS, LIVE_FRAME_MS } from "@mako/host/contracts/live-conversations"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { flushFrameMs, LONG_ANSWER_CHARS, LONG_ANSWER_FLUSH_MS } from "@mako/host/conversations/answer-pace"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { subscribeRuntime } from "@mako/host/transport/connection"
import { startWebHost, streamWrites } from "@mako/host/transport/server"
import { COMPACT_LIVE_FORM, WINDOW_LIVE_FORM } from "@mako/protocol/live-form"
import { shownBlocks } from "../src/state/live-projection.js"
import { StreamFrames, STREAM_FRAME_MIN_MS, STREAM_FRAME_MS } from "../src/lib/stream-frames.js"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/* ------------------------------------------------------------ a clock the test turns */

const clock = { now: 0 }
const realNow = performance.now.bind(performance)
mock.method(performance, "now", () => clock.now)
mock.timers.enable({ apis: ["setTimeout"] })
/** A millisecond at a time, so a timer fires in the millisecond it was due. */
function advance(ms: number, each?: (at: number) => void): void {
  for (let step = 0; step < ms; step += 1) {
    clock.now += 1
    mock.timers.tick(1)
    each?.(clock.now)
  }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-ahead-"))
  const id = randomUUID()
  const state: LiveSessionState = { id, nativeId: "native-1", harness: "test-provider", cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
  const heard: { at: number; event: HostEvent }[] = []
  const turns: PromiseWithResolvers<void>[] = []
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async () => state,
    prompt: async (_id, _text, _attachments, _tuning, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const turn = Promise.withResolvers<void>()
      turns.push(turn)
      await turn.promise
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  const dependencies = { appPath: root, root, driver: () => driver, history: async () => null, emit: (event: HostEvent) => { heard.push({ at: clock.now, event }) } }
  const owner = new LiveConversations(dependencies)
  return {
    id, state, heard, owner, dependencies,
    /** A turn under way: the prompt handed over and the session running, as a driver says them. */
    async prompted(): Promise<void> {
      await owner.start("test-provider", root, { conversationId: id })
      await settle()
      owner.submit(id, randomUUID(), "Explain")
      await settle()
      owner.observe({ type: "live-session", session: { ...state, status: "running" } })
    },
    say: (text: string, block = "a1") => owner.observe({ type: "live-update", id, update: { kind: "text", id: block, text } }),
    async cleanup(): Promise<void> {
      for (const turn of turns) turn.resolve()
      await owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The answer's text each batch added, in order, and what a window drew and when: each batch, and what was said ahead of the next over the batch it names. */
function read(heard: readonly { at: number; event: HostEvent }[]) {
  const batches: { at: number; revision: number; text: string }[] = []
  const drawn: { at: number; characters: number }[] = []
  const aheads: { at: number; revision: number; more: string }[] = []
  let held = 0
  let shown = 0
  let revision = -1
  for (const { at, event } of heard) {
    if (event.type === "live-batch") {
      const text = event.batch.updates.map((update) => (update.kind === "text" ? update.text : "")).join("")
      batches.push({ at, revision: event.batch.revision, text })
      revision = event.batch.revision
      held += text.length
      shown = Math.max(shown, held)
    } else if (event.type === "live-ahead") {
      aheads.push({ at, revision: event.ahead.revision, more: event.ahead.more })
      if (event.ahead.revision === revision) shown = Math.max(shown, held + event.ahead.more.length)
    } else continue
    drawn.push({ at, characters: shown })
  }
  return { batches, drawn, aheads }
}

/**
 * The pacing as it was before windows heard anything ahead of a batch, for an answer's text going on after a quiet
 * moment: every token joins what waits, and what waits goes a frame after the last flush, or the long answer's hold.
 * `tokens` by the millisecond each arrives; the text of each batch, and when it went.
 */
function before(first: string, tokens: ReadonlyMap<number, string>, from: number, until: number): { at: number; text: string }[] {
  const batches: { at: number; text: string }[] = []
  let text = first
  let pending = ""
  let flushedAt = Number.NEGATIVE_INFINITY
  let due: number | undefined
  for (let at = from + 1; at <= until; at += 1) {
    if (due !== undefined && due <= at) {
      batches.push({ at, text: pending })
      text += pending
      pending = ""
      flushedAt = at
      due = undefined
    }
    const token = tokens.get(at)
    if (token === undefined) continue
    pending += token
    const frame = flushFrameMs(LIVE_FRAME_MS, [{ type: "text", id: "a1", text }], [{ kind: "text", id: "a1", text: pending }], false)
    const next = flushedAt + frame
    if (due === undefined || next < due) due = next
  }
  return batches
}

/* ---------------------------------------------- the batches are the ones they were */

{
  const f = fixture()
  const commits = mock.method(LiveJournal.prototype, "commit")
  try {
    await f.prompted()
    advance(5)
    // A turn's first words go at once, though its own status flushes have just started a frame.
    const statusFlushes = f.heard.filter(({ event }) => event.type === "live-batch").length
    assert.ok(statusFlushes > 0, "the turn's start flushed its status")
    f.say("Hello ")
    // Its flush is a timer of no wait, which the clock's next turn fires.
    advance(1)
    const first = read(f.heard).batches.at(-1)
    assert.equal(first?.text, "Hello ", "the first text went at once")
    assert.equal(first?.at, clock.now, "not a frame after the status before it")
    // Only the first: what follows it keeps the frame, whatever else the turn says meanwhile.
    advance(5)
    f.say("there ")
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "text", id: "a1", text: "and " } })
    assert.equal(read(f.heard).batches.at(-1)?.text, "Hello ", "the next words wait")
    advance(LIVE_FRAME_MS)
    const second = read(f.heard).batches.at(-1)
    assert.equal(second?.text, "there and ", "and go together")
    assert.equal(second!.at - first!.at, LIVE_FRAME_MS, "a frame after the first")

    // A long answer going on, after a quiet moment: a token every 7 ms, a paragraph now and then.
    advance(1_000)
    const from = clock.now
    const mark = f.heard.length
    const commitsFrom = commits.mock.callCount()
    const tokens = new Map<number, string>()
    for (let index = 0; index < 420; index += 1) tokens.set(from + 3 + index * 7, (index + 1) % 90 === 0 ? "word.\n\n" : "word ")
    const until = from + 3 + 420 * 7 + 1_000
    advance(until - from, (at) => {
      const token = tokens.get(at)
      if (token !== undefined) f.say(token)
    })
    const { batches, drawn, aheads } = read(f.heard.slice(mark))
    const was = before("Hello there and ", tokens, from, until)
    assert.ok(was.length > 20 && was.some((batch, index) => index > 0 && batch.at - was[index - 1]!.at === LONG_ANSWER_FLUSH_MS), "the answer got long enough to be held to a reader's pace")
    assert.deepEqual(batches.map(({ at, text }) => ({ at, text })), was, "every batch is the one the old pacing sent: the same count, the same text, at the same millisecond, in the same order")
    assert.equal(commits.mock.callCount() - commitsFrom, was.length, "and the journal committed once for each, no more")
    assert.ok(batches.every((batch, index) => index === 0 || batch.revision === batches[index - 1]!.revision + 1), "their revisions go up by one")
    assert.equal([...tokens.values()].join("").length > LONG_ANSWER_CHARS, true)

    // A window never waits past its own frame for a token, held answer or not.
    let total = "Hello there and ".length
    const marked = read(f.heard.slice(0, mark)).drawn.at(-1)?.characters ?? 0
    assert.equal(marked, total, "the window held everything before the stream began")
    let worst = 0
    let worstBatches = 0
    let held = total
    const reached = (list: readonly { at: number; characters: number }[], characters: number) => list.find((each) => each.characters >= characters)?.at
    const batched = batches.map(({ at, text }) => ({ at, characters: (held += text.length) }))
    for (const [at, token] of tokens) {
      total += token.length
      const window = reached(drawn.map((each) => ({ at: each.at, characters: each.characters + marked })), total)
      const device = reached(batched, total)
      assert.ok(window !== undefined && device !== undefined, "every token arrives")
      worst = Math.max(worst, window - at)
      worstBatches = Math.max(worstBatches, device - at)
    }
    // A timer due in the millisecond a token lands fires on the clock's next turn.
    assert.ok(worst <= LIVE_AHEAD_MS + 1, `a window waited ${worst} ms for a token; its frame is ${LIVE_AHEAD_MS}`)
    assert.ok(worstBatches > LONG_ANSWER_FLUSH_MS - 10, `while the batches held one ${worstBatches} ms, as they did`)
    // What's said ahead is said of the batch a window holds, and is all that waits: one missed costs nothing.
    assert.ok(aheads.length > was.length, "most tokens are said ahead of their batch")
    for (const ahead of aheads) {
      const base = batches.findLast((batch) => batch.at <= ahead.at)
      assert.ok(!base || ahead.revision === base.revision, "each names the revision the last batch made")
      const next = batches.find((batch) => batch.at > ahead.at || (batch.at === ahead.at && batch.revision > ahead.revision))
      assert.ok(next?.text.startsWith(ahead.more), "and the batch that follows begins with the same text")
    }
    assert.ok(aheads.every((ahead, index) => index === 0 || ahead.at - aheads[index - 1]!.at >= LIVE_AHEAD_MS || ahead.revision !== aheads[index - 1]!.revision || ahead.at === aheads[index - 1]!.at + LIVE_AHEAD_MS), "at most one a frame")

    // A snapshot read mid-stream is the batches so far; what was said ahead of it is the start of what it adds.
    f.say("tail ")
    advance(LIVE_AHEAD_MS + 1)
    f.say("end")
    advance(LIVE_AHEAD_MS + 1)
    const said = read(f.heard).aheads.at(-1)!
    assert.equal(said.more, "end", "the first went as a batch after the quiet; the second waits for its frame, said ahead")
    const snapshot = f.owner.snapshot(f.id)!
    const last = snapshot.blocks.at(-1)
    const streamed = "Hello there and " + [...tokens.values()].join("") + "tail end"
    assert.ok(last?.type === "text" && last.text === streamed, "the snapshot holds what was streamed, ahead included")
    assert.equal(snapshot.revision, read(f.heard).batches.at(-1)?.revision, "at the revision of the batch reading it flushed")
    assert.equal(snapshot.revision, said.revision + 1, "one past the revision the text was said ahead of, so a window drops that text for the batch")
  } finally {
    commits.mock.restore()
    await f.cleanup()
  }
}

/* --------------------------------- what else a turn says keeps the batches' own frame */

{
  const f = fixture()
  try {
    await f.prompted()
    f.say("First ")
    advance(1_000)
    const mark = f.heard.length
    // A call beside the text is not text going on: nothing is said ahead, and it goes on the frame as ever.
    f.say("then ")
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "tool", id: "t1", title: "Read", status: "running" } })
    advance(LIVE_FRAME_MS + 1)
    f.say("after the call", "a2")
    advance(LIVE_AHEAD_MS + 1)
    const { aheads } = read(f.heard.slice(mark))
    assert.deepEqual(aheads, [], "only text that goes on with the last block is said ahead; a new block waits for its batch")
    advance(LIVE_FRAME_MS)
    assert.ok(read(f.heard.slice(mark)).batches.some((batch) => batch.text === "after the call"), "which the frame brings")
  } finally {
    await f.cleanup()
  }
}

mock.timers.reset()
mock.method(performance, "now", realNow)

/* ------------------------------------------------- only windows, and only while they read */

{
  const root = mkdtempSync(join(tmpdir(), "mako-live-ahead-"))
  const socket = join(root, "host.sock")
  const host = await startWebHost(socket, async () => "null", async () => new Response("fixture"), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: [] })
  const written = new Map<string, { lines: number; bytes: number }>()
  const uncount = streamWrites.subscribe(({ client, type, line }) => {
    if (type !== "live-ahead") return
    const so = written.get(client) ?? { lines: 0, bytes: 0 }
    written.set(client, { lines: so.lines + 1, bytes: so.bytes + Buffer.byteLength(line) })
  })
  /** A window's stream that takes nothing, so what's written to it waits in the host. */
  const stalled = async () => {
    const client = randomUUID()
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const asked = request({ agent: false, socketPath: socket, path: "/events", method: "POST", headers: { "x-mako-window": client, "x-mako-history": "1", "x-mako-live": String(WINDOW_LIVE_FORM) } }, resolve)
      asked.on("error", reject)
      asked.end()
    })
    let text = ""
    response.setEncoding("utf8").on("data", (chunk: string) => { text += chunk })
    response.on("error", () => {})
    while (!text.includes("\"ready\"")) await delay(5)
    response.pause()
    return { client, heard: () => text, resume: () => response.resume(), leave: () => response.destroy() }
  }
  const reading = (live: typeof WINDOW_LIVE_FORM | typeof COMPACT_LIVE_FORM) => {
    const heard: string[] = []
    let ready = false
    const stop = subscribeRuntime(socket, randomUUID(), (packet) => {
      if (packet.channel === "ready") ready = true
      else if (packet.channel === "event" && packet.type !== undefined) heard.push(packet.type)
    }, () => undefined, { history: true, live })
    return { heard, stop, ready: () => ready }
  }
  try {
    const window = reading(WINDOW_LIVE_FORM)
    const device = reading(COMPACT_LIVE_FORM)
    const slow = await stalled()
    while (!window.ready() || !device.ready()) await delay(5)
    const id = randomUUID()
    const SENT = 200
    // As a stream's tokens come: a small line every frame, which a window that reads takes each of.
    for (let index = 0; index < SENT; index += 1) {
      host.windowEvent({ type: "live-ahead", ahead: { id, revision: 1, epoch: "e", more: "word ".repeat(index + 1) } })
      if (index % 10 === 9) await delay(2)
    }
    host.event({ type: "live-batch", batch: { id, revision: 2, epoch: "e", updates: [{ kind: "text", id: "a1", text: "the batch" }] } })
    await delay(200)
    assert.equal(window.heard.filter((type) => type === "live-ahead").length, SENT, "a window that reads hears every one")
    assert.deepEqual(device.heard, ["live-batch"], "a reader of the compact form, as the gateway's link is, hears the batch and nothing ahead of it")
    // Far more than a socket takes unread: past what the system buffers, the host holds a line's worth and no more.
    const more = "x".repeat(64 * 1024)
    const wrote = () => [...written].find(([client]) => client.endsWith(slow.client))?.[1] ?? { lines: 0, bytes: 0 }
    const small = wrote().lines
    for (let index = 0; index < SENT; index += 1) {
      host.windowEvent({ type: "live-ahead", ahead: { id, revision: 2, epoch: "e", more } })
      if (index % 20 === 19) await delay(5)
    }
    const held = { lines: wrote().lines - small, bytes: wrote().bytes }
    assert.ok(held.lines < SENT / 2, `a window that isn't reading was written ${held.lines} of ${SENT} large lines: the rest were left out, not queued`)
    const settledAt = wrote().lines
    for (let index = 0; index < 50; index += 1) host.windowEvent({ type: "live-ahead", ahead: { id, revision: 2, epoch: "e", more } })
    assert.equal(([...written].find(([client]) => client.endsWith(slow.client))?.[1].lines ?? 0), settledAt, "and it's written no more while it holds what it has")
    slow.resume()
    for (const deadline = Date.now() + 5_000; !slow.heard().includes("the batch"); await delay(10)) assert.ok(Date.now() < deadline, "the batch reaches it once it reads again")
    await delay(100)
    host.windowEvent({ type: "live-ahead", ahead: { id, revision: 2, epoch: "e", more: "caught up" } })
    for (const deadline = Date.now() + 5_000; !slow.heard().includes("caught up"); await delay(10)) assert.ok(Date.now() < deadline, "and hears what's said ahead again once it has caught up")
    slow.leave()
    window.stop()
    device.stop()
  } finally {
    uncount()
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/* -------------------------------------------------------------- what a window draws */

{
  const blocks = [{ type: "user" as const, text: "Explain", requestId: "r1" }, { type: "text" as const, id: "a1", text: "So far" }]
  const drawn = shownBlocks({ blocks, revision: 7, ahead: { revision: 7, more: " and on" } })
  assert.deepEqual(drawn.at(-1), { type: "text", id: "a1", text: "So far and on" }, "the last block goes on with what was said ahead of its revision")
  assert.equal(blocks[1]!.text, "So far", "the blocks it holds are untouched")
  assert.equal(shownBlocks({ blocks, revision: 8, ahead: { revision: 7, more: " and on" } }), blocks, "said of another revision, nothing of it is drawn: the batch carried it")
  assert.equal(shownBlocks({ blocks: [blocks[0]!], revision: 7, ahead: { revision: 7, more: "x" } }).length, 1, "nor where no text is last")

  // The window's own throttle bounds its paints and parses whatever the host's pace: text landing every paint frame
  // paints as often as text landing every 50 ms did, each paint showing the latest.
  const at = { now: 0 }
  const timers: { due: number; run: () => void }[] = []
  const paints: { at: number; text: string }[] = []
  const frames = new StreamFrames((text) => paints.push({ at: at.now, text }), {
    now: () => at.now,
    schedule: (run, ms) => {
      const timer = { due: at.now + ms, run }
      timers.push(timer)
      return () => { timers.splice(timers.indexOf(timer), 1) }
    },
  })
  let text = ""
  for (; at.now <= 1_000; at.now += 1) {
    for (const timer of timers.filter((each) => each.due <= at.now)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.run()
    }
    if (at.now % LIVE_AHEAD_MS === 0) frames.next(text += "word ")
  }
  // A small piece paints every other frame its text is said ahead on, so a line is drawn within a frame or two of
  // coming; one that takes a while to parse is what the throttle holds to the batches' frame (below).
  assert.ok(paints.length >= 1_000 / STREAM_FRAME_MIN_MS - 2 && paints.length <= 1_000 / STREAM_FRAME_MIN_MS + 1, `${paints.length} paints in a second of text every ${LIVE_AHEAD_MS} ms`)
  assert.ok(paints.every((paint, index) => index === 0 || paint.at - paints[index - 1]!.at >= STREAM_FRAME_MIN_MS), "never two within its frame")
  assert.ok(paints.every((paint, index) => index === 0 || text.startsWith(paint.text) && paint.text.length > paints[index - 1]!.text.length), "each showing more")
  // The same lines into a piece of 9,000 characters: its parse is what a paint costs, and it paints on the batches' frame.
  const from = paints.length
  const began = at.now
  for (; at.now <= began + 1_000; at.now += 1) {
    for (const timer of timers.filter((each) => each.due <= at.now)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.run()
    }
    if (at.now % LIVE_AHEAD_MS === 0) frames.next(text += "word ", 9_000)
  }
  const long = paints.slice(from)
  assert.ok(long.length <= 1_000 / STREAM_FRAME_MS + 1, `${long.length} paints in a second of a long piece`)
  assert.ok(long.every((paint, index) => index === 0 || paint.at - long[index - 1]!.at >= STREAM_FRAME_MS), "never two within the long piece's frame")
}

console.log("live ahead: a window hears waiting text within its frame, the batches go as they did, a turn's first words go at once, and a window that stops reading is told nothing ahead")
