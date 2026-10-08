// Explicit isolated fixture. It runs the production timeline and state/cache
// actions, with an immutable in-memory history source; no agent is started.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { TooltipProvider } from "@/components/ui/tooltip"
import { TranscriptPaneContext } from "@/state/conversation-scope"
import { acpStore, useAcp } from "@/state/acp-state"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { watchLiveResidency } from "@/state/live-residency"
import { liveReadingSource, transcriptReaders } from "@/state/transcript-reading"
import { getMako } from "@/lib/bridge"
import type { LiveSnapshot } from "@/lib/types"
import type { LiveHistoryPage } from "../../electron/contracts/live-history"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()
const page = document.getElementById("root")!
page.className = "p-4 text-ui"
const button = document.createElement("button")
button.textContent = "Run history residency checks"
button.className = "pressable text-ui"
const output = document.createElement("pre")
output.className = "whitespace-pre-wrap text-ui"
const fixture = document.createElement("div")
fixture.className = "fixed bottom-0 right-0 flex w-full"
page.append(button, output, fixture)
const root = createRoot(fixture)
const views = new Map<string, LiveSnapshot>()
getMako().liveRead = async (id, input) => {
  const snapshot = views.get(id)
  if (!snapshot?.history) throw new Error("Missing fixture source")
  let value: LiveSnapshot | LiveHistoryPage
  if (input.kind === "range") value = {
    blocks: snapshot.blocks.slice(input.from.blocks, input.to.blocks), base: null,
    history: { ...snapshot.history, blockStart: input.from.blocks, blockEnd: input.to.blocks, turnStart: input.from.blocks / 2, before: null },
  }
  else if (input.kind === "snapshot") value = snapshot
  else throw new Error("Unexpected fixture read")
  const data = JSON.stringify(value)
  return { record: crypto.randomUUID(), offset: 0, total: data.length, data, next: null }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
  output.textContent += `\nPASS ${message}`
}
async function until(test: () => boolean) {
  const deadline = performance.now() + 5000
  while (!test()) {
    if (performance.now() > deadline) throw new Error("History UI condition timed out")
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
}
async function frames(count = 4) {
  for (let index = 0; index < count; index++) await new Promise(resolve => requestAnimationFrame(resolve))
}

function makeView(turns: number): LiveSnapshot {
  const id = crypto.randomUUID()
  const blocks: LiveSnapshot["blocks"] = []
  for (let index = 0; index < turns; index++) blocks.push(
    { type: "user", requestId: `question-${index}`, text: `Question ${index}` },
    { type: "text", text: Array.from({ length: 8 }, (_, paragraph) =>
      `Turn ${index}, paragraph ${paragraph}. The reader keeps this paragraph at the same place while distant history leaves memory and comes back.`).join("\n\n") })
  const snapshot: LiveSnapshot = {
    session: { id, harness: "fixture", cwd: "/fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
    createdAt: 1, revision: 1, epoch: id, blocks, base: null, permissions: [], requests: [],
    history: { token: crypto.randomUUID(), ranges: true, blockStart: 0, blockEnd: blocks.length, turnStart: 0, earlierRequests: [], before: null },
  }
  views.set(id, snapshot)
  applyLiveSnapshot(snapshot)
  return snapshot
}

export function ReadingPane({ id, pane }: { id: string; pane: string }) {
  const projection = useAcp(state => state.conversations[id]?.projection)
  return (
    <TranscriptPaneContext value={pane}>
      <div className="flex h-96 min-w-0 flex-1 flex-col" data-reader-pane={pane}>
        <ConversationTimeline identity={id} source={{ liveId: id, historyFrom: { blocks: 0, base: 0 } }}
          exchanges={projection?.exchanges ?? []} entrance={false} empty={null} />
      </div>
    </TranscriptPaneContext>
  )
}
function show(id: string) {
  flushSync(() => root.render(
    <TooltipProvider><ReadingPane id={id} pane="residency-left" /><ReadingPane id={id} pane="residency-right" /></TooltipProvider>
  ))
}
function marker(scroller: HTMLElement): HTMLElement {
  const box = scroller.getBoundingClientRect()
  const center = box.top + box.height / 2
  const painted = document.elementFromPoint(box.left + box.width / 2, center)?.closest<HTMLElement>("p")
  const element = painted ?? Array.from(scroller.querySelectorAll<HTMLElement>("p"))
    .filter(item => item.getBoundingClientRect().bottom > box.top && item.getBoundingClientRect().top < box.bottom)
    .sort((a, b) => Math.abs(a.getBoundingClientRect().top - center) - Math.abs(b.getBoundingClientRect().top - center))[0]
  if (!element || !scroller.contains(element)) throw new Error("No painted paragraph at the reading position")
  return element
}
async function beginReading(scroller: HTMLDivElement, fraction: number) {
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
  scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(4)
  scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
}

async function residency(windowed: boolean) {
  const snapshot = makeView(windowed ? 240 : 80)
  acpStore.set({ activeKey: snapshot.session.id })
  show(snapshot.session.id)
  await frames(8)
  const scrollers = Array.from(fixture.querySelectorAll<HTMLDivElement>(".scroll-fade-scroller"))
  check(scrollers.length === 2, "two independent panes render the shared conversation")
  await Promise.all([beginReading(scrollers[0]!, 0.3), beginReading(scrollers[1]!, 0.7)])
  await frames(8)
  // An instant synthetic scroll otherwise emits a real scrollend before
  // the next frame. Hold that event to exercise continuing drag momentum.
  const deferEnd = (event: Event) => event.stopImmediatePropagation()
  scrollers[0]!.addEventListener("scrollend", deferEnd, true)
  scrollers[0]!.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }))
  scrollers[0]!.scrollTop += 1
  scrollers[0]!.dispatchEvent(new Event("scroll", { bubbles: true }))
  scrollers[0]!.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }))
  await frames()
  check(transcriptReaders.protected(liveReadingSource(snapshot.session.id)) === undefined,
    "releasing a drag keeps cleanup paused until scroll motion ends")
  scrollers[0]!.removeEventListener("scrollend", deferEnd, true)
  scrollers[0]!.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames()
  const left = marker(scrollers[0]!), right = marker(scrollers[1]!)
  const leftId = left.closest("[data-exchange]")!.getAttribute("data-exchange")!
  const rightId = right.closest("[data-exchange]")!.getAttribute("data-exchange")!
  const before = [left.getBoundingClientRect().top, right.getBoundingClientRect().top]
  const range = document.createRange()
  range.selectNodeContents(left)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  await frames()
  const stop = watchLiveResidency({ bytes: 1, recent: 0 })
  try {
    await frames(8)
    check(!acpStore.get().conversations[snapshot.session.id]!.releasedTurns?.length, "selection postpones structural cleanup in both panes")
    selection.removeAllRanges()
    await until(() => !!acpStore.get().conversations[snapshot.session.id]!.releasedTurns?.length)
    await frames(8)
    const current = acpStore.get().conversations[snapshot.session.id]!
    check(!current.releasedTurns!.some(turn => [leftId, rightId].includes(turn.id)), "both actual reading positions survive memory pressure")
    check(left.isConnected && right.isConnected, "cleanup retains the visible paragraph nodes")
    const drift = Math.max(Math.abs(left.getBoundingClientRect().top - before[0]!), Math.abs(right.getBoundingClientRect().top - before[1]!))
    check(drift <= 2, `cleanup preserves both reading offsets (${windowed ? "virtual" : "normal"}, ${drift.toFixed(2)}px)`)
    const saved = [marker(scrollers[0]!), marker(scrollers[1]!)].map(element => ({ text: element.textContent, top: element.getBoundingClientRect().top }))
    const other = makeView(3)
    show(other.session.id)
    await frames(6)
    show(snapshot.session.id)
    await frames(10)
    for (let index = 0; index < 2; index++) {
      const element = Array.from(scrollers[index]!.querySelectorAll<HTMLElement>("p")).find(item => item.textContent === saved[index]!.text)
      if (!element || Math.abs(element.getBoundingClientRect().top - saved[index]!.top) > 2)
        output.textContent += `\nBookmark evidence ${JSON.stringify({ expected: saved[index], actual: element?.getBoundingClientRect().top,
          connected: scrollers[index]!.isConnected, bookmark: transcriptReaders.bookmark(liveReadingSource(snapshot.session.id), index ? "residency-right" : "residency-left"),
          scrollTop: scrollers[index]!.scrollTop })}`
      check(!!element && Math.abs(element.getBoundingClientRect().top - saved[index]!.top) <= 2,
        `pane ${index + 1} restores its own paragraph after switching chats`)
    }
    // Jump through the production navigator to a released turn. Its full
    // body comes from the immutable range reader and replaces the placeholder.
    const released = acpStore.get().conversations[snapshot.session.id]!.releasedTurns![0]!
    const firstPane = fixture.querySelector('[data-reader-pane="residency-left"]')!
    const jump = firstPane.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(released.label)}"]`)
    if (!windowed) {
      check(!!jump, "released turns retain their navigator labels")
      jump.click()
      await until(() => !acpStore.get().conversations[snapshot.session.id]!.releasedTurns?.some(turn => turn.id === released.id))
      const turn = firstPane.querySelector(`[data-exchange="${CSS.escape(released.id)}"]`)
      check(!!turn?.textContent?.includes(`Turn ${released.blocks.start / 2}, paragraph 7`), "jumping to released history reloads the complete answer")
    }
    await until(() => transcriptReaders.protected(liveReadingSource(snapshot.session.id)) !== undefined)
    check(true, "the settled panes publish a complete reading report")
  } finally { stop(); selection.removeAllRanges(); flushSync(() => root.render(null)) }
}

async function partialAnswer() {
  const original = makeView(3)
  const id = crypto.randomUUID()
  const partial = { ...original, session: { ...original.session, id }, epoch: id,
    blocks: original.blocks.slice(1), history: { ...original.history!, token: crypto.randomUUID(), blockEnd: original.blocks.length - 1 } }
  views.set(id, partial)
  applyLiveSnapshot(partial)
  show(id)
  try {
    await frames(8)
    const scroller = fixture.querySelector<HTMLDivElement>(".scroll-fade-scroller")!
    await beginReading(scroller, 0.12)
    await frames(8)
    const paragraph = marker(scroller)
    check(paragraph.closest("[data-exchange]")?.getAttribute("data-exchange") === "lead", "a partial leading answer has a measured paragraph bookmark")
    const text = paragraph.textContent, top = paragraph.getBoundingClientRect().top
    show(makeView(3).session.id)
    await frames(6)
    show(id)
    await frames(10)
    const restored = Array.from(scroller.querySelectorAll<HTMLElement>("p")).find(item => item.textContent === text)
    check(!!restored && Math.abs(restored.getBoundingClientRect().top - top) <= 2,
      "returning to a partial answer restores the paragraph, even without its question loaded")
  } finally { flushSync(() => root.render(null)) }
}

button.onclick = async () => {
  button.disabled = true
  output.textContent = "Running history residency checks…"
  try {
    await residency(false)
    await residency(true)
    await partialAnswer()
    output.textContent += "\nAll history residency checks passed."
  } catch (error) { output.textContent += `\nFAIL ${error instanceof Error ? error.message : String(error)}` }
  finally { button.disabled = false }
}
