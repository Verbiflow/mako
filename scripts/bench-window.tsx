/**
 * The page `scripts/bench-window.mjs` drives: the production transcript panel, rail and composer on the mock bridge,
 * with one recorded turn (`npm run bench:vs-bare -- --record`) fed to it as the window takes its stream. What it
 * measures and what it can't say are in that script's header.
 *
 * Each line is decoded as the window's preload decodes it (`decodeRuntimeEvent`) and handed to the function
 * `src/state/session.ts` routes its type to (`applyLiveBatch`, `applyLiveAhead`), in a task of its own at its recorded
 * time. Every timer is set before the first runs, so none is nested and none is held to a nested timer's 4 ms.
 */
import { Profiler, type ProfilerOnRenderCallback } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveRequest, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { decodeRuntimeEvent } from "@mako/host/contracts/runtime-value"
import { AcpPanel } from "../src/components/viewer/acp-panel"
import { AgentThreads } from "../src/components/rail/agent-threads"
import { Composer } from "../src/components/composer/composer"
import { WorkspaceFocusContext } from "../src/components/stage/workspace-focus-context"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { installMockBridge } from "../src/dev/mock-bridge"
import { acpStore } from "../src/state/acp-state"
import { applyLiveAhead, applyLiveBatch, applyLiveSnapshot } from "../src/state/live-recovery"
import { watchLiveResidency } from "../src/state/live-residency"
import { threadsStore } from "../src/state/thread-store"
import { store } from "../src/state/session"
import { auditSnapshot } from "./performance-audit-fixtures"
import "../src/index.css"

/** One line of a recorded turn: when it reached the window, in ms after the turn's send, and its event's JSON text. */
interface Line { at: number; payload: string }
interface ReplayInput {
  /** The conversation right before the turn's send, as `mako:live-snapshot` answered. */
  snapshot: LiveSnapshot
  lines: Line[]
  /** Earlier turns made up and put before the snapshot's own. */
  turns: number
  /** False leaves out what was said ahead of the batches, which is what a window heard before `LiveAhead`. */
  ahead: boolean
}
interface Arrival {
  kind: string
  /** When it was due and when its task began, in ms after the stream's start. */
  due: number
  at: number
  decodeMs: number
  applyMs: number
  /** Whether the conversation's shown text grew with it. */
  text: boolean
  /** The characters of the last block as shown after it, when that block is text: its own and what was said ahead. */
  last: number | null
  /** Which of the turn's text blocks that is, counted from 1; 0 is the text the conversation ended on before it. */
  segment: number
  /** Its task up to the microtask queued after the apply, which runs behind React's own: decode, apply and the synchronous render and commit. */
  taskMs: number | null
  commits: number
  commitMs: number
  /** From its task's start to the next frame's callbacks, and to the first task after that frame's rendering. */
  frameMs: number | null
  renderedMs: number | null
}

const fixture = installMockBridge()
watchLiveResidency()

const commits: { id: string; at: number; ms: number }[] = []
const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration, _baseDuration, startTime) => {
  commits.push({ id, at: startTime, ms: actualDuration })
}
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The made-up turns before a base's own entries, as a long conversation's native history holds them. */
function withEarlier(base: LiveSnapshot["base"], earlier: LiveSnapshot["blocks"]): LiveSnapshot["base"] {
  return base && earlier.length ? { ...base, entries: [...earlier, ...base.entries], total: base.total + earlier.length } : base
}

/**
 * A recorded line for a conversation that holds `earlier` before the blocks it was recorded against: a batch counts
 * blocks from the conversation's first, so its counts move by that many, and a base it carries gets the same turns.
 */
function shifted(payload: string, earlier: LiveSnapshot["blocks"]): string {
  const event = decodeRuntimeEvent<HostEvent>(payload)
  if (event.type !== "live-batch" || !earlier.length) return payload
  const batch = { ...event.batch }
  if (batch.blockCount !== undefined) batch.blockCount += earlier.length
  if (batch.changedFrom !== undefined) batch.changedFrom += earlier.length
  if (batch.baseCoveredBlocks !== undefined) batch.baseCoveredBlocks += earlier.length
  if (batch.base) batch.base = withEarlier(batch.base, earlier)
  return JSON.stringify({ ...event, batch })
}

let prepared: { id: string; lines: Line[]; blocks: number; rereads: { count: number; first: string | null } } | undefined

/** Opens the conversation as it was before the turn, with `turns` earlier ones, active and at its end. */
/** How often the window read the conversation again during a replay, and where from the first time. */
interface Rereads { count: number; first: string | null }

async function prepare(input: ReplayInput) {
  const made = auditSnapshot(input.turns, input.snapshot.session.harness, 512, 256)
  const earlier = made.blocks
  const finished: LiveRequest[] = made.requests.map((request) => ({ ...request, status: "completed" }))
  const snapshot: LiveSnapshot = {
    ...input.snapshot,
    blocks: [...earlier, ...input.snapshot.blocks],
    base: withEarlier(input.snapshot.base, earlier),
    requests: [...finished, ...input.snapshot.requests],
  }
  // The made-up turns are in the base too, as a long conversation's own are once its native record was read.
  if (input.snapshot.base && earlier.length) snapshot.baseCoveredBlocks = (input.snapshot.baseCoveredBlocks ?? 0) + earlier.length
  const id = snapshot.session.id
  fixture.setLiveSnapshot(snapshot)
  // A batch this window can't read makes it read the conversation again, which here would start the turn over.
  const rereads: Rereads = { count: 0, first: null }
  const bridge = window.mako
  if (!bridge) throw new Error("The mock bridge is missing")
  const read = bridge.liveSnapshot
  bridge.liveSnapshot = (asked) => {
    rereads.count += 1
    // Who asked first, for a run this fails: the conversation as held then, and the call's stack.
    const held = acpStore.get().conversations[asked]
    rereads.first ??= `${Math.round(performance.now())} ms, held ${held?.kind === "live" ? `${held.hydrated ? "whole" : "listed"} at revision ${held.revision}` : "not at all"}: ${new Error("read").stack ?? ""}`
    return read(asked)
  }
  flushSync(() => {
    acpStore.set({ activeKey: id, conversations: {} })
    threadsStore.set({ threads: [], viewing: null, opening: null, loaded: true, composerHarness: snapshot.session.harness })
    store.set({ messages: [], stream: null })
    applyLiveSnapshot(snapshot)
  })
  await document.fonts.ready
  await frames()
  const deadline = performance.now() + 20_000
  while (!document.querySelector("[data-transcript-viewport] [data-exchange]")) {
    if (performance.now() > deadline) throw new Error("The transcript didn't draw the conversation")
    await pause(25)
  }
  // The end settles over a few frames as rows are measured; the stream starts on a quiet page.
  await pause(1_000)
  await frames()
  rereads.count = 0
  rereads.first = null
  const lines = input.lines
    .filter((line) => input.ahead || decodeRuntimeEvent<HostEvent>(line.payload).type !== "live-ahead")
    .map((line) => ({ at: line.at, payload: shifted(line.payload, earlier) }))
  prepared = { id, lines, blocks: snapshot.blocks.length, rereads }
  return { lines: lines.length, ...page() }
}

function page() {
  const viewport = document.querySelector("[data-transcript-viewport]")
  return {
    mountedTurns: document.querySelectorAll("[data-exchange]").length,
    rows: Math.max(-1, ...[...document.querySelectorAll<HTMLElement>("[data-transcript-viewport] [data-index]")].map((row) => Number(row.dataset.index))) + 1,
    domNodes: document.getElementsByTagName("*").length,
    fromEndPx: viewport ? Math.round(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) : null,
  }
}

/** Feeds the prepared lines at their recorded spacing and returns what each cost, with every frame and long task. */
async function stream() {
  if (!prepared) throw new Error("Nothing is prepared")
  const { id, lines, blocks: held, rereads } = prepared
  const viewport = document.querySelector("[data-transcript-viewport]")
  if (!viewport) throw new Error("The transcript has no viewport")
  commits.length = 0
  const arrivals: Arrival[] = []
  const starts: number[] = []
  const ticks: { at: number; changed: boolean; rendered: number | null; segment: number }[] = []
  // The last answer's prose on the page is the answer being written (a prompt is prose too, and isn't one). Each time
  // another element takes that place the frames count a new segment, as the lines do for each new text block, so a
  // frame's count is read against its own block's.
  const prose = viewport.getElementsByClassName("mako-prose")
  const answer = () => {
    for (let index = prose.length - 1; index >= 0; index -= 1) {
      const element = prose.item(index)
      if (element && !element.classList.contains("prompt-prose")) return element
    }
    return null
  }
  let drawing = answer()
  let drawnSegment = 0
  const longTasks: { at: number; ms: number }[] = []
  const tasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ at: entry.startTime, ms: entry.duration })
  })
  tasks.observe({ type: "longtask" })
  // A frame "drew a change" when the transcript's nodes or text changed since the frame before.
  let dirty = false
  const mutations = new MutationObserver(() => { dirty = true })
  mutations.observe(viewport, { subtree: true, childList: true, characterData: true })

  let awaitingFrame: Arrival[] = []
  let awaitingRender: Arrival[] = []
  let running = true
  // A message posted from a frame's callbacks is the first task after that frame's style, layout and paint.
  const afterFrame = new MessageChannel()
  afterFrame.port1.onmessage = () => {
    const now = performance.now()
    for (const arrival of awaitingRender) arrival.renderedMs = now - began - arrival.at
    awaitingRender = []
  }
  const tick = () => {
    const now = performance.now()
    // The characters of its source that answer has drawn (`data-rendered-chars`).
    const element = answer()
    if (element !== drawing) {
      drawing = element
      drawnSegment += 1
    }
    const drawn = element?.getAttribute("data-rendered-chars") ?? null
    ticks.push({ at: now - began, changed: dirty || mutations.takeRecords().length > 0, rendered: drawn === null ? null : Number(drawn), segment: drawnSegment })
    dirty = false
    if (awaitingFrame.length) {
      for (const arrival of awaitingFrame) arrival.frameMs = now - began - arrival.at
      awaitingRender.push(...awaitingFrame)
      awaitingFrame = []
      afterFrame.port2.postMessage(0)
    }
    if (running) requestAnimationFrame(tick)
  }

  /** The characters of text the turn has added so far, with what's shown ahead of the next batch. */
  let counted: { blocks: LiveSnapshot["blocks"]; characters: number } | undefined
  const shown = () => {
    const conversation = acpStore.get().conversations[id]
    if (conversation?.kind !== "live") return 0
    if (counted?.blocks !== conversation.blocks) {
      let characters = 0
      for (const block of conversation.blocks.slice(held)) if (block.type === "text") characters += block.text.length
      counted = { blocks: conversation.blocks, characters }
    }
    const ahead = conversation.ahead
    return counted.characters + (ahead && ahead.revision === conversation.revision && conversation.blocks.at(-1)?.type === "text" ? ahead.more.length : 0)
  }
  let most = 0
  const textKey = () => {
    const conversation = acpStore.get().conversations[id]
    const block = conversation?.kind === "live" ? conversation.blocks.at(-1) : undefined
    return conversation?.kind === "live" && block?.type === "text" ? block.id ?? `block ${conversation.blocks.length}` : undefined
  }
  let writing = textKey()
  let segment = 0
  const take = (line: Line, due: number) => {
    const start = performance.now()
    const event = decodeRuntimeEvent<HostEvent>(line.payload)
    const decoded = performance.now()
    if (event.type === "live-batch") applyLiveBatch(event.batch)
    else if (event.type === "live-ahead") applyLiveAhead(event.ahead)
    const applied = performance.now()
    const characters = shown()
    const conversation = acpStore.get().conversations[id]
    const block = conversation?.kind === "live" ? conversation.blocks.at(-1) : undefined
    const said = conversation?.kind === "live" ? conversation.ahead : undefined
    const more = said && conversation?.kind === "live" && said.revision === conversation.revision ? said.more.length : 0
    const key = textKey()
    if (key !== undefined && key !== writing) {
      writing = key
      segment += 1
    }
    const arrival: Arrival = { kind: event.type, due, at: start - began, decodeMs: decoded - start, applyMs: applied - decoded, text: characters > most, last: block?.type === "text" ? block.text.length + more : null, segment, taskMs: null, commits: 0, commitMs: 0, frameMs: null, renderedMs: null }
    most = Math.max(most, characters)
    arrivals.push(arrival)
    starts.push(start)
    awaitingFrame.push(arrival)
    queueMicrotask(() => { arrival.taskMs = performance.now() - start })
  }

  performance.mark("bench-window-start")
  const began = performance.now()
  requestAnimationFrame(tick)
  const first = lines[0]?.at ?? 0
  const last = (lines.at(-1)?.at ?? 0) - first
  await new Promise<void>((resolve) => {
    for (const [index, line] of lines.entries()) {
      const due = line.at - first
      setTimeout(() => {
        take(line, due)
        if (index === lines.length - 1) resolve()
      }, Math.max(0, began + due - performance.now()))
    }
    if (!lines.length) resolve()
  })
  // The last text's paint waits out the prose throttle, and a long task is reported a moment after it ends.
  await pause(500)
  await frames()
  running = false
  performance.mark("bench-window-end")
  const ended = performance.now() - began
  for (const entry of tasks.takeRecords()) longTasks.push({ at: entry.startTime, ms: entry.duration })
  tasks.disconnect()
  mutations.disconnect()
  afterFrame.port1.close()

  // A commit belongs to the arrival before it: what React rendered between one line and the next.
  const byProfiler = new Map<string, { commits: number; ms: number }>()
  let owner = -1
  for (const commit of commits) {
    while (owner + 1 < starts.length && starts[owner + 1]! <= commit.at) owner += 1
    const arrival = arrivals[owner]
    if (arrival) {
      arrival.commits += 1
      arrival.commitMs += commit.ms
    }
    const total = byProfiler.get(commit.id) ?? { commits: 0, ms: 0 }
    byProfiler.set(commit.id, { commits: total.commits + 1, ms: total.ms + commit.ms })
  }
  const conversation = acpStore.get().conversations[id]
  return {
    arrivals,
    ticks,
    longTasks: longTasks.map((task) => ({ at: task.at - began, ms: task.ms })).filter((task) => task.at + task.ms >= 0),
    commits: Object.fromEntries(byProfiler),
    lastDueMs: last,
    endedMs: ended,
    rereads: rereads.count,
    firstReread: rereads.first,
    revision: conversation?.kind === "live" ? conversation.revision ?? null : null,
    characters: most,
    blocks: conversation?.kind === "live" ? conversation.blocks.length : null,
    ...page(),
  }
}

const api = { prepare, stream }
declare global {
  interface Window {
    benchWindow: typeof api
  }
}

function View() {
  return (
    <TooltipProvider>
      <WorkspaceFocusContext value={{ identity: "bench-window", cwd: "/bench-window", title: "Window bench", ready: true }}>
        <div className="flex h-screen bg-surface">
          <aside className="w-64 shrink-0 border-r border-hairline">
            <Profiler id="rail" onRender={onRender}>
              <AgentThreads />
            </Profiler>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <Profiler id="transcript" onRender={onRender}>
              <AcpPanel />
            </Profiler>
            <Profiler id="composer" onRender={onRender}>
              <Composer />
            </Profiler>
          </main>
        </div>
      </WorkspaceFocusContext>
    </TooltipProvider>
  )
}
const root = document.getElementById("root")
if (!root) throw new Error("The page has no root")
flushSync(() => createRoot(root).render(<View />))
window.benchWindow = api
