// Rendered regression using synthetic history and production residency, paging and timeline.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { TooltipProvider } from "@/components/ui/tooltip"
import { TranscriptPaneContext } from "@/state/conversation-scope"
import { acpStore, useAcp } from "@/state/acp-state"
import { applyLiveBatch, hydrateLive } from "@/state/live-recovery"
import { watchLiveResidency } from "@/state/live-residency"
import { transcriptReaders, liveReadingSource } from "@/state/transcript-reading"
import { getMako } from "@/lib/bridge"
import { reduceLiveUpdates, LiveUpdateSchema } from "@mako/sessions/live-content"
import { HistoryRecords, HistoryVersions, historyCapture, historyRange, type HistoryValue } from "@mako/host/contracts/history-pages"
import type { LiveSnapshot } from "@/lib/types"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

declare global { interface Window { fixtureTimeAdvance: number } }
installMockBridge()

function auditSnapshot(turns: number, harness: string, answerChars: number, toolChars: number): LiveSnapshot {
  const result: LiveSnapshot = {
    session: { id: "fixture-source", harness, cwd: "/fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: 1, base: null, blocks: [], requests: [], permissions: [],
  }
  for (let turn = 0; turn < turns; turn++) {
    const requestId = `00000000-0000-4000-8000-${(turn + 1).toString(16).padStart(12, "0")}`
    const text = `Inspect file ${turn}.`
    result.requests.push({ id: requestId, text, attachments: [], status: "completed", createdAt: 1 })
    result.blocks.push({ type: "user", text, requestId },
      { type: "tool", id: `tool-${turn}`, title: "Read", toolKind: "read", status: "completed", input: "{}", output: "line of output\n".repeat(Math.ceil(toolChars / 15)).slice(0, toolChars) },
      { type: "text", id: `text-${turn}`, text: `## Finding ${turn}\n\n${"The implementation preserves identity and clear interaction feedback. ".repeat(Math.ceil(answerChars / 68)).slice(0, answerChars)}` })
  }
  return result
}

const frames = async (count = 5) => { for (let n = 0; n < count; n++) await new Promise(requestAnimationFrame) }
const until = async (test: () => boolean) => {
  const end = performance.now() + 8_000
  while (!test()) { if (performance.now() > end) throw new Error("fixture condition timed out"); await frames(1) }
}
const rootNode = document.createElement("div")
rootNode.style.cssText = "position:fixed;inset:0;background:var(--background)"
document.body.replaceChildren(rootNode)
const root = createRoot(rootNode)
const id = crypto.randomUUID()
let source: LiveSnapshot
const versions = new HistoryVersions()
const records = new HistoryRecords()
const views = new Map<string, LiveSnapshot>()
const calls: object[] = []
getMako().liveRead = async (_id: string, input: LiveHistoryRead) => {
  const call = { kind: input.kind, ...input.kind === "range" && { from: input.from, to: input.to }, error: "" }
  calls.push(call)
  try {
    if (input.kind === "part") return records.part(id, input.record, input.offset)
    let value: HistoryValue
    if (input.kind === "snapshot") {
      const held = input.ifCurrent && views.get(input.ifCurrent.token)
      if (held && input.epoch !== undefined && held.epoch === input.epoch && source.epoch === input.epoch && held.revision === source.revision)
        value = { kind: "unchanged", token: input.ifCurrent!.token, revision: source.revision, epoch: source.epoch }
      else {
        const token = crypto.randomUUID()
        views.set(token, source)
        value = historyCapture(token, source, versions, input.from)
      }
    } else if (input.kind === "range") {
      const view = views.get(input.token)
      if (!view) throw new Error("fixture view missing")
      value = historyRange(input.token, view, input.from, input.to, versions)
    } else throw new Error(`Unexpected fixture read ${input.kind}`)
    return records.open(id, value)
  } catch (error) { call.error = String(error); throw error }
}
export function Pane() {
  const projection = useAcp(state => state.conversations[id]?.projection)
  return <TooltipProvider><TranscriptPaneContext value="incident-check">
    <div className="flex h-screen min-w-0 flex-col">
      <ConversationTimeline identity={id} source={{ liveId: id, historyFrom: { blocks: 0, base: 0 } }}
        exchanges={projection?.exchanges ?? []} entrance={false} empty={null} />
    </div>
  </TranscriptPaneContext></TooltipProvider>
}
const current = () => acpStore.get().conversations[id]!
const scroller = () => rootNode.querySelector<HTMLDivElement>(".scroll-fade-scroller")!
let target = ""
let measured = 0
const writes: object[] = []
let externalScroll = false
let correctionEvents = false
let correctedScrollEnds = 0
async function moveTo(turn: string) {
  const scroll = scroller()
  scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }))
  const element = rootNode.querySelector<HTMLElement>(`[data-exchange="${turn}"]`)!
  externalScroll = true
  try { scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 48 }
  finally { externalScroll = false }
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(8)
  scroll.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(8)
}
async function prepare(releaseCold = true) {
  source = { ...auditSnapshot(2, "fixture", 8_000, 4 * 1024 * 1024), epoch: "g1.pixels00.one" }
  source.session = { ...source.session, id, status: "ready" }
  source.requests = source.requests.map(r => ({ ...r, status: "completed" }))
  await hydrateLive(id)
  acpStore.set({ activeKey: id })
  const next = auditSnapshot(12, "fixture", 8_000, 4 * 1024 * 1024)
  next.requests = next.requests.map(r => ({ ...r, status: "completed" }))
  const updates = LiveUpdateSchema.array().parse(next.blocks.slice(6).map(({ type, ...entry }) => ({ kind: type, ...entry })))
  source = { ...source, revision: 2, blocks: reduceLiveUpdates(source.blocks, updates), requests: next.requests }
  applyLiveBatch({ id, epoch: source.epoch, revision: 2, updates, requests: source.requests, changedFrom: 6, blockCount: source.blocks.length })
  target = current().projection!.exchanges[2]!.id
  flushSync(() => root.render(<Pane />))
  await frames(12)
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!
  Object.defineProperty(scroller(), "scrollTop", {
    configurable: true,
    get() { return descriptor.get!.call(this) },
    set(value: number) {
      writes.push({ from: descriptor.get!.call(this), to: value,
        turnTop: rootNode.querySelector(`[data-exchange="${target}"]`)?.getBoundingClientRect().top,
        stack: new Error().stack?.split("\n").slice(2, 6) })
      if (writes.length > 80) writes.shift()
      descriptor.set!.call(this, value)
      // Deliver the observed browser ordering before the next resize observation: a correction's scroll consumes
      // its ownership, then scrollend reports the same position while content-visibility still holds old geometry.
      if (correctionEvents && !externalScroll) queueMicrotask(() => {
        correctedScrollEnds++
        scroller().dispatchEvent(new Event("scroll", { bubbles: true }))
        scroller().dispatchEvent(new Event("scrollend", { bubbles: true }))
      })
    },
  })
  await moveTo(target)
  measured = rootNode.querySelector(`[data-exchange="${target}"]`)!.getBoundingClientRect().height
  const newest = current().projection!.exchanges.at(-1)!.id
  await moveTo(newest)
  // Residency's documented one-minute recency expires without a real minute's wait.
  window.fixtureTimeAdvance += 61_000
  const stop = releaseCold ? watchLiveResidency() : () => {}
  try { if (releaseCold) await until(() => !!current().releasedTurns?.some(t => t.id === target)) }
  finally { stop() }
  await frames(5)
  calls.length = 0
  return inspect()
}
async function restoreTarget(deliverCorrectionEvents: boolean) {
  writes.length = 0
  correctionEvents = deliverCorrectionEvents
  try { await moveTo(target); await frames(20) }
  finally { correctionEvents = false }
  if (deliverCorrectionEvents && correctedScrollEnds === 0) throw new Error("The fixture did not deliver a correction scrollend")
}
async function reveal() {
  await restoreTarget(true)
  const result = inspect()
  if (result.released || !result.text?.includes("Finding 2") || Math.abs((result.top ?? 0) - 48) > 2)
    throw new Error(`Restored target must remain painted at 48px; got ${JSON.stringify(result)}`)
  anchor()
  return result
}
// Apply a continuing reader movement after a real correction write, before its queued callback/resize pass.
// This observes only the scroller property; it never reaches into React refs or invokes a private handler.
async function overlappingScroll(amount: number) {
  const node = scroller()
  const descriptor = Object.getOwnPropertyDescriptor(node, "scrollTop")!
  let armed = true
  let movement = 0
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get() { return descriptor.get!.call(this) },
    set(value: number) {
      const stack = new Error().stack ?? ""
      descriptor.set!.call(this, value)
      if (!armed || !stack.includes("preserveScrollAnchor")) return
      armed = false
      queueMicrotask(() => {
        const before = descriptor.get!.call(node)
        descriptor.set!.call(node, before + amount)
        movement = descriptor.get!.call(node) - before
        node.dispatchEvent(new Event("scroll", { bubbles: true }))
      })
    },
  })
  try { await restoreTarget(false) }
  finally { Object.defineProperty(node, "scrollTop", descriptor) }
  return { amount, movement, injected: !armed, state: inspect() }
}
async function settledScroll(amount: number) {
  await reveal()
  const node = scroller()
  const before = node.scrollTop
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: amount, bubbles: true }))
  node.scrollTop += amount
  const movement = node.scrollTop - before
  node.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(8)
  node.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(8)
  const state = inspect()
  const streamed = await stream()
  return { amount, movement, injected: true, state, streamed }
}
function anchor() {
  const row = rootNode.querySelector<HTMLElement>(`[data-exchange="${target}"]`)!
  const paragraph = Array.from(row.querySelectorAll("p")).find(p => p.textContent?.includes("implementation"))!
  if (!paragraph || paragraph.textContent?.length !== 8000) throw new Error("Restoration did not paint the complete paragraph")
  const box = paragraph.getBoundingClientRect()
  if (box.bottom <= 0 || box.top >= innerHeight || !row.innerText.includes("Finding 2")) throw new Error("The target paragraph is not actually painted in the viewport")
  return { paragraph, top: paragraph.getBoundingClientRect().top }
}
async function stream(count = 1) {
  const before = anchor()
  const viewportBefore = inspect()
  const held = current()
  applyLiveBatch({ id, epoch: held.epoch!, revision: (held.revision ?? 2) + 1,
    updates: Array.from({ length: count }, () => [
      { kind: "user" as const, text: "New streaming turn after restored history", requestId: crypto.randomUUID() },
      { kind: "text" as const, id: crypto.randomUUID(), text: "Stream continued below the reader." },
    ]).flat(),
    changedFrom: held.history!.blockEnd, blockCount: held.history!.blockEnd + count * 2 })
  await frames(15)
  const drift = before.paragraph.getBoundingClientRect().top - before.top
  const after = inspect()
  if (!before.paragraph.isConnected || Math.abs(drift) > 2 || Math.abs((after.top ?? 0) - (viewportBefore.top ?? 0)) > 2) throw new Error("Stream moved the painted reading anchor")
  return { drift, paragraphPreserved: before.paragraph.isConnected, before: viewportBefore, after }
}
async function duplicateScrollEnd() {
  const before = anchor()
  const node = scroller()
  node.dispatchEvent(new Event("scroll", { bubbles: true }))
  node.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(8)
  const drift = before.paragraph.getBoundingClientRect().top - before.top
  if (!before.paragraph.isConnected || Math.abs(drift) > 2) throw new Error(`Duplicate scrollend moved the paragraph by ${drift}px`)
  return { drift }
}
async function boundedRows() {
  const result = await stream(68)
  const node = scroller()
  const rows = [...node.querySelectorAll("[data-exchange]")]
  const identities = rows.map(row => row.getAttribute("data-exchange"))
  if (!node.hasAttribute("data-virtualized") || rows.length > 32 || new Set(identities).size !== identities.length)
    throw new Error(`History must remain windowed with unique bounded rows; got ${rows.length}`)
  return { ...result, total: current().projection!.exchanges.length, mounted: rows.length }
}
async function fractionalScroll() {
  const before = anchor()
  const node = scroller()
  const offset = node.scrollTop
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: 0.5, bubbles: true }))
  node.scrollTop += 0.5
  const movement = node.scrollTop - offset
  node.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(5)
  node.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(5)
  if (Math.abs(before.paragraph.getBoundingClientRect().top - (before.top - movement)) > 0.1)
    throw new Error("Fractional reader movement was swallowed")
  const streamed = await stream()
  if (Math.abs(streamed.drift) > 0.1) throw new Error("A stream undid the half-pixel reading position")
  const held = anchor()
  await resize(innerWidth, innerHeight - 80)
  const resizeDrift = held.paragraph.getBoundingClientRect().top - held.top
  if (Math.abs(resizeDrift) > 0.1) throw new Error(`Resize undid the half-pixel reading position by ${resizeDrift}px`)
  return { movement, streamed, resizeDrift }
}
async function resize(width: number, height: number) {
  const before = anchor()
  if (!frameElement) throw new Error("Viewport checks require the isolated frame")
  frameElement.setAttribute("style", `position:fixed;inset:0;width:${width}px;height:${height}px;border:0`)
  await frames(20)
  const drift = before.paragraph.getBoundingClientRect().top - before.top
  // Below half a CSS pixel: a lost 0.5px reader movement must not hide in layout rounding.
  if (!before.paragraph.isConnected || Math.abs(drift) > 0.25) throw new Error(`Resize changed the reading position by ${drift}px`)
  return { drift, width, resizedViewportHeight: height, ...inspect() }
}
function inspect() {
  const node = rootNode.querySelector<HTMLElement>(`[data-exchange="${target}"]`)
  const scroll = scroller()
  const box = node?.getBoundingClientRect()
  return { correctedScrollEnds, movementGuardLoaded: String(ConversationTimeline).includes("positionChanged"), id, target, measured, released: !!current().releasedTurns?.some(t => t.id === target),
    text: node?.innerText.slice(0, 400), height: box?.height, top: box?.top, viewport: scroll?.clientHeight,
    scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
    painted: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.textContent?.slice(0, 180),
    calls: calls.map(call => ({ ...call })), writes: [...writes], protected: [...(transcriptReaders.protected(liveReadingSource(id)) ?? [])] }
}
async function run() {
  await prepare()
  const restored = await reveal()
  const streamed = await stream()
  const fractional = await fractionalScroll()
  const resized = await resize(700, 720)
  const identities = Array.from(rootNode.querySelectorAll("[data-exchange]")).map(node => node.getAttribute("data-exchange"))
  if (new Set(identities).size !== identities.length || identities.length !== current().projection!.exchanges.length)
    throw new Error("Restoration duplicated or lost a mounted turn")
  return { restored, streamed, fractional, resized, identities }
}
const runButton = document.createElement("button")
runButton.textContent = "Run released turn rendering checks"
runButton.style.cssText = "position:fixed;right:16px;top:8px;z-index:100;background:#333;color:white;padding:8px"
document.body.append(runButton)
runButton.onclick = async () => {
  runButton.disabled = true
  try {
    const result = await run()
    Object.assign(window, { incidentResult: { ok: true, result } })
    runButton.textContent = "Released turn rendering checks passed"
  } catch (error) {
    Object.assign(window, { incidentResult: { ok: false, error: String(error), state: inspect() } })
    runButton.textContent = "Released turn rendering checks failed"
  }
}
Object.assign(window, { incidentCheck: { prepare, reveal, inspect, overlappingScroll, settledScroll, stream, duplicateScrollEnd, fractionalScroll, boundedRows, resize, run } })
