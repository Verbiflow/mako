// Explicit fixture page. Exercises the production attachment and media renderer.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { TranscriptPaneContext } from "@/state/conversation-scope"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getMako } from "@/lib/bridge"
import type { Exchange } from "@/lib/exchanges"
import type { FileContents } from "@/lib/types"
import { installMockBridge } from "./mock-bridge"
import { MEDIA_SCROLL_VIDEO } from "./media-scroll-video"
import { transcriptReaders } from "@/state/transcript-reading"
import { prefsStore } from "@/state/prefs"
import previewAudioUrl from "./assets/preview.wav?url"
import "../index.css"

installMockBridge()
const page = document.getElementById("root")!
const button = document.createElement("button")
button.textContent = "Run media scroll checks"
const output = document.createElement("pre")
const fixture = document.createElement("div")
fixture.className = "fixed right-0 bottom-0 w-[640px]"
page.append(button, output, fixture)
const root = createRoot(fixture)
const frames = (count = 4) => new Promise<void>(resolve => {
  const tick = () => { if (--count === 0) resolve(); else requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
})
// ResizeObserver corrects layout after animation callbacks and before paint.
// Sample from the next task so an intermediate pre-correction layout is not
// reported as a frame that was actually visible.
const paintedFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
async function until(test: () => boolean, label = "media") {
  const deadline = performance.now() + 5000
  while (!test()) {
    if (performance.now() > deadline) throw new Error(`Media fixture timed out: ${label}`)
    await frames(1)
  }
}
function image(name: string, height = 600): FileContents {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${height}"><rect width="600" height="${height}" fill="#23778a"/><text x="40" y="200" fill="white">${name}</text></svg>`
  return { path: name, contents: "", size: 0, binary: true, truncated: false,
    mimeType: "image/svg+xml", previewUrl: `data:image/svg+xml;base64,${btoa(svg)}` }
}
function show(exchanges: Exchange[], identity: string) {
  flushSync(() => root.render(<TooltipProvider><TranscriptPaneContext value="media-scroll-pane">
    <div className="flex h-[480px] flex-col"><ConversationTimeline identity={identity} exchanges={exchanges} empty={null} entrance={false} /></div>
  </TranscriptPaneContext></TooltipProvider>))
}
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  output.textContent += `\nPASS ${message}`
}
async function mediaAnchor(windowed: boolean) {
  const params = new URL(location.href).searchParams
  const lateVideo = params.has("video")
  const targetVideo = params.has("videoTarget")
  const loadingTarget = params.has("loadingTarget")
  const lateName = lateVideo ? "late.mp4" : "late.svg"
  let resolveFile: (file: FileContents) => void = () => {}
  let requested = false
  const fileRead = new Promise<FileContents>(resolve => { resolveFile = resolve })
  let resolveTarget: (file: FileContents) => void = () => {}
  const targetRead = new Promise<FileContents>(resolve => { resolveTarget = resolve })
  getMako().readFile = async path => {
    if (path === "reading.svg" && loadingTarget) return targetRead
    requested = true
    return fileRead
  }
  const video = (name: string): FileContents => ({ path: name, contents: "", size: 0, binary: true, truncated: false, mimeType: "video/mp4", previewUrl: MEDIA_SCROLL_VIDEO })
  const target = targetVideo ? video("reading.mp4") : image("reading.svg")
  const exchanges: Exchange[] = [{ id: "media-turn", system: [], response: [
    { id: "late-media", role: "assistant", blocks: [{ type: "attachment", name: lateName, mimeType: lateVideo ? "video/mp4" : "image/svg+xml", source: { kind: "file", path: lateName } }] },
    { id: "reading-media", role: "assistant", blocks: [{ type: "attachment", name: target.path, mimeType: target.mimeType!, source: loadingTarget ? { kind: "file", path: target.path } : { kind: "url", url: target.previewUrl! } }] },
    { id: "tail", role: "assistant", blocks: [{ type: "text", text: Array.from({ length: 24 }, (_, i) => `Tail paragraph ${i}. Room to read the media above without following the end.`).join("\n\n") }] },
  ] }]
  if (params.has("duplicate")) exchanges[0]!.response.splice(1, 0, {
    id: "same-named-media", role: "assistant", blocks: [{ type: "attachment", name: target.path, mimeType: target.mimeType!, source: { kind: "url", url: target.previewUrl! } }],
  })
  if (windowed) exchanges.unshift(...Array.from({ length: 200 }, (_, i) => ({ id: `before-${i}`, system: [], response: [{ id: `before-answer-${i}`, role: "assistant" as const, blocks: [{ type: "text" as const, text: `Earlier answer ${i}.` }] }] })))
  const identity = `media-${windowed}`
  show(exchanges, identity)
  await frames(8)
  const scroller = fixture.querySelector<HTMLDivElement>(".scroll-fade-scroller")!
  const late = fixture.querySelector<HTMLElement>(`[data-inline-file-preview="${lateName}"]`)!
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
  scroller.scrollTop += late.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await until(() => requested, "file request")
  const targetSelector = `[data-inline-file-preview="${target.path}"]${loadingTarget ? "" : ` ${targetVideo ? "video" : "img"}`}`
  await until(() => !!fixture.querySelector(targetSelector))
  const media = Array.from(fixture.querySelectorAll<HTMLElement>(targetSelector)).at(-1)!
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
  scroller.scrollTop += media.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  if (media instanceof HTMLImageElement) await until(() => media.complete && media.naturalHeight > 0, "reading image decoded")
  // The first placement starts lazy decoding. Before it finishes the pane's
  // center may still be text below a zero-height image; establish the actual
  // media reading position only after that initial layout has settled.
  await frames(4)
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
  scroller.scrollTop += media.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(8)
  scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(4)
  if (Math.abs(media.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40) > 2)
    throw new Error("Media fixture could not establish the visible reading position")
  const moving = params.has("moving")
  const deferEnd = (event: Event) => event.stopImmediatePropagation()
  if (moving) {
    scroller.addEventListener("scrollend", deferEnd, true)
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
    scroller.scrollTop -= 20
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
    await frames(2)
  }
  const before = media.getBoundingClientRect().top
  const beforeScroll = scroller.scrollTop
  resolveFile(lateVideo ? video(lateName) : image(lateName))
  if (loadingTarget) resolveTarget(target)
  if (lateVideo) {
    await until(() => !!fixture.querySelector(`[data-inline-file-preview="${lateName}"] video`))
    const loaded = fixture.querySelector<HTMLVideoElement>(`[data-inline-file-preview="${lateName}"] video`)!
    loaded.load()
    await until(() => loaded.videoHeight > 0, "video metadata")
  } else await until(() => !!fixture.querySelector<HTMLImageElement>(`img[alt="${lateName}"]`)?.naturalHeight)
  const samples = []
  for (let frame = 0; frame < 12; frame++) {
    await frames(1)
    samples.push({ top: media.getBoundingClientRect().top, scroll: scroller.scrollTop, late: late.getBoundingClientRect().height })
  }
  const drift = Math.abs(media.getBoundingClientRect().top - before)
  if (drift > 2) output.textContent += `\nEvidence ${JSON.stringify({ before, beforeScroll, samples })}`
  check(drift <= 2, `late ${lateVideo ? "video metadata" : "image load"} preserves the visible ${loadingTarget ? "loading preview" : targetVideo ? "video" : "image"} (${windowed ? "virtual" : "flow"}${moving ? ", during scroll motion" : ""}, ${drift.toFixed(2)}px drift)`)
  if (moving) {
    scroller.removeEventListener("scrollend", deferEnd, true)
    scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
    await frames(4)
  }
  const start = media.getBoundingClientRect().top
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -35, bubbles: true }))
  scroller.scrollTop -= 35
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(4)
  scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(4)
  check(Math.abs(media.getBoundingClientRect().top - start - 35) <= 2, "layout correction preserves the next 35px of reader scrolling")
  const savedTop = media.getBoundingClientRect().top
  show([{ id: "other", system: [], response: [{ id: "other-answer", role: "assistant", blocks: [{ type: "text", text: "Another conversation." }] }] }], "other")
  await frames(8)
  show(exchanges, identity)
  await until(() => !!fixture.querySelector(targetSelector))
  const restored = Array.from(fixture.querySelectorAll<HTMLElement>(targetSelector)).at(-1)!
  if (restored instanceof HTMLImageElement) await until(() => restored.naturalHeight > 0)
  await frames(12)
  const returnDrift = Math.abs(restored.getBoundingClientRect().top - savedTop)
  check(returnDrift <= 2, `switching chats restores the visible ${targetVideo ? "video" : "image"} (${windowed ? "virtual" : "flow"}, ${returnDrift.toFixed(2)}px drift)`)
  if (targetVideo && restored instanceof HTMLVideoElement) {
    // A mouse interaction with native video controls must retain the anchor.
    restored.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }))
    restored.load()
    restored.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }))
    await until(() => restored.videoHeight > 0, "visible video metadata")
    await frames(8)
    check(Math.abs(restored.getBoundingClientRect().top - savedTop) <= 2, "starting the visible video keeps its position through metadata layout")
  }
  const owner = Array.from(fixture.querySelectorAll<HTMLElement>(`[data-inline-file-preview="${target.path}"]`)).at(-1)!
  const expand = owner.querySelector<HTMLButtonElement>('button[title="Expand preview"]')!
  const inlineHeight = owner.getBoundingClientRect().height
  const ownerTop = owner.getBoundingClientRect().top
  expand.click()
  await until(() => !!document.querySelector('[data-expanded-file-preview]'))
  await frames(4)
  check(Math.abs(owner.getBoundingClientRect().height - inlineHeight) <= 2, "expanded gallery retains the inline media height")
  document.querySelector<HTMLButtonElement>('[data-expanded-file-preview] button[aria-label="Close preview"]')!.click()
  await until(() => !document.querySelector('[data-expanded-file-preview]'))
  await frames(8)
  check(Math.abs(owner.getBoundingClientRect().top - ownerTop) <= 2, "closing the gallery retains the inline reading position")
  const fold = fixture.querySelector<HTMLButtonElement>(`[data-inline-file-preview="${lateName}"] button[aria-label="Preview ${lateName}"]`)!
  const foldReading = transcriptReaders.bookmark(`timeline:${identity}`, "media-scroll-pane")
  // Closing video recreates a metadata-free element. If the center now shows
  // text below it, that paragraph is the reading anchor for the next action.
  const readingText = foldReading?.anchor?.block?.kind !== "preview" ? foldReading?.anchor?.block : undefined
  const paragraph = readingText ? Array.from(fixture.querySelectorAll("p")).find(item => (item.textContent ?? "").slice(0, 160) === readingText.text) : undefined
  const foldingAnchor = paragraph ?? owner
  const foldingTop = foldingAnchor.getBoundingClientRect().top
  fold.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }))
  fold.click()
  fold.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }))
  await frames(8)
  check(Math.abs(foldingAnchor.getBoundingClientRect().top - foldingTop) <= 2, "folding a preview above the current reading anchor retains its position")
}

async function collectionAnchor(windowed: boolean) {
  const pictures = [image("one.svg"), image("two.svg")]
  const exchanges: Exchange[] = [{ id: "collection-turn", system: [], response: [
    { id: "collection", role: "assistant", blocks: pictures.map(file => ({ type: "attachment" as const, name: file.path, mimeType: file.mimeType!, source: { kind: "url" as const, url: file.previewUrl! } })) },
    { id: "collection-tail", role: "assistant", blocks: [{ type: "text", text: Array.from({ length: 24 }, (_, i) => `Collection paragraph ${i}. Reading text beneath a gallery while images open and close.`).join("\n\n") }] },
  ] }]
  if (windowed) exchanges.unshift(...Array.from({ length: 200 }, (_, i) => ({ id: `collection-before-${i}`, system: [], response: [{ id: `collection-answer-${i}`, role: "assistant" as const, blocks: [{ type: "text" as const, text: `Earlier answer ${i}.` }] }] })))
  show(exchanges, `collection-${windowed}`)
  await frames(8)
  const scroller = fixture.querySelector<HTMLDivElement>(".scroll-fade-scroller")!
  const paragraph = Array.from(fixture.querySelectorAll("p")).find(item => item.textContent?.startsWith("Collection paragraph 2."))!
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
  scroller.scrollTop += paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 220
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(4)
  scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(4)
  const before = paragraph.getBoundingClientRect().top
  const tile = fixture.querySelector<HTMLButtonElement>('button[aria-label="Show one.svg"]')!
  const click = () => {
    tile.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }))
    tile.click()
    tile.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }))
  }
  click()
  await until(() => !!fixture.querySelector<HTMLImageElement>('img[alt="one.svg"]')?.naturalHeight)
  await frames(8)
  check(Math.abs(paragraph.getBoundingClientRect().top - before) <= 2, `opening grouped attachments keeps the visible paragraph (${windowed ? "virtual" : "flow"})`)
  click()
  await frames(8)
  check(Math.abs(paragraph.getBoundingClientRect().top - before) <= 2, `closing grouped attachments keeps the visible paragraph (${windowed ? "virtual" : "flow"})`)
}

async function renderingAnchor(windowed: boolean, kind: string) {
  const prose = Array.from({ length: 24 }, (_, i) => `Document paragraph ${i}. **Formatted text** and a [link](https://example.test) keep their native layout.`).join("\n\n")
  const code = Array.from({ length: 24 }, (_, i) => `const value${i} = ${i};`).join("\n")
  const table = "| Name | Value |\n| --- | --- |\n" + Array.from({ length: 24 }, (_, i) => `| Row ${i} | Value ${i} |`).join("\n")
  let blocks: Exchange["response"][number]["blocks"]
  let selector: string
  const inlineDocument = ["html", "markdown", "csv", "har"].includes(kind)
  if (inlineDocument) {
    const name = `document.${kind === "markdown" ? "md" : kind}`
    const text = kind === "html" ? "<!doctype html><html><head></head><body><h1>Interactive document</h1><button onclick=\"this.textContent='Updated'\">Update document</button></body></html>"
      : kind === "csv" ? "Name,Value\n" + Array.from({ length: 24 }, (_, i) => `Row ${i},${i}`).join("\n")
      : kind === "har" ? JSON.stringify({ log: { entries: [{ startedDateTime: "2026-01-01T00:00:00Z", time: 12, request: { method: "GET", url: "https://example.test" }, response: { status: 200, content: { size: 100 } }, timings: { wait: 12 } }] } }) : prose
    blocks = [{ type: "attachment", name, mimeType: kind === "html" ? "text/html" : kind === "csv" ? "text/csv" : kind === "har" ? "application/json" : "text/markdown", source: { kind: "inline", data: btoa(text) } }]
    selector = `[data-inline-document="${name}"]`
  } else if (kind === "pdf" || kind === "audio") {
    const name = kind === "pdf" ? "document.pdf" : "audio.wav"
    blocks = [{ type: "attachment", name, mimeType: kind === "pdf" ? "application/pdf" : "audio/wav", source: { kind: "url", url: kind === "pdf" ? pdfFixture() : new URL(previewAudioUrl, location.href).href } }]
    selector = `[data-inline-file-preview="${name}"]`
  } else if (kind === "diff" || kind === "tool") {
    blocks = [{ type: "toolCall", id: "render-tool", name: "fixture_tool", arguments: {} },
      { type: "toolResult", id: "render-tool", name: "fixture_tool", text: code.repeat(4), details: kind === "diff" ? [{ type: "diff", path: "fixture.ts", oldText: "", newText: code }] : undefined }]
    selector = "[data-tool-body]"
  } else {
    blocks = [{ type: "text", text: kind === "table" ? table : kind === "diagram" ? "```mermaid\nflowchart TD\n" + Array.from({ length: 12 }, (_, i) => `A${i}[Step ${i}] --> A${i + 1}[Step ${i + 1}]`).join("\n") + "\n```" : `\`\`\`typescript\n${code}\n\`\`\`` }]
    selector = kind === "table" ? ".mako-table" : ".mako-code"
  }
  let resolveFile: (file: FileContents) => void = () => {}
  let requested = false
  const read = new Promise<FileContents>(resolve => { resolveFile = resolve })
  getMako().readFile = async () => { requested = true; return read }
  const exchanges: Exchange[] = [{ id: `render-${kind}`, system: [], response: [
    { id: "render-late", role: "assistant", blocks: [{ type: "attachment", name: "above.svg", mimeType: "image/svg+xml", source: { kind: "file", path: "above.svg" } }] },
    { id: "render-target", role: "assistant", blocks },
    { id: "render-tail", role: "assistant", blocks: [{ type: "text", text: prose }] },
  ] }]
  if (windowed) exchanges.unshift(...Array.from({ length: 200 }, (_, i) => ({ id: `render-before-${i}`, system: [], response: [{ id: `render-answer-${i}`, role: "assistant" as const, blocks: [{ type: "text" as const, text: `Earlier answer ${i}.` }] }] })))
  show(exchanges, `render-${kind}-${windowed}`)
  await frames(8)
  const scroller = fixture.querySelector<HTMLDivElement>(".scroll-fade-scroller")!
  const scrollTo = async (element: Element) => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
    const offset = Math.max(40, (scroller.clientHeight - element.getBoundingClientRect().height) / 2)
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
    await frames(8)
    scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
    await frames(4)
  }
  await scrollTo(fixture.querySelector('[data-inline-file-preview="above.svg"]')!)
  await until(() => requested, "rendering file request")
  if (inlineDocument) fixture.querySelector<HTMLButtonElement>(`${selector} button[aria-expanded]`)!.click()
  if (kind === "diff" || kind === "tool") fixture.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click()
  await until(() => !!fixture.querySelector(selector), "rendered target")
  const target = fixture.querySelector<HTMLElement>(selector)!
  if (kind === "html") await until(() => !!target.querySelector("iframe"), "HTML preview")
  if (kind === "markdown") await until(() => !!target.querySelector(".mako-prose"), "Markdown document")
  if (kind === "csv") await until(() => !!target.querySelector("table"), "CSV document")
  if (kind === "har") await until(() => !!target.querySelector('[aria-label="Filter diagnostic rows"]'), "diagnostic worker rendering")
  if (kind === "pdf") await until(() => !!target.querySelector('[aria-busy="false"] canvas'), "PDF canvas rendering")
  if (kind === "audio") {
    await until(() => !!target.querySelector("audio"), "audio player")
    const audio = target.querySelector("audio")!
    audio.load()
    await until(() => audio.readyState > 0, "audio metadata")
  }
  await scrollTo(target)
  if (kind === "diagram") await until(() => !!target.querySelector<HTMLImageElement>("img")?.naturalHeight, "Mermaid rendering")
  await scrollTo(target)
  const viewport = scroller.getBoundingClientRect()
  const bounds = target.getBoundingClientRect()
  const center = viewport.top + viewport.height / 2
  if (bounds.top > center || bounds.bottom < center || bounds.left >= viewport.right || bounds.right <= viewport.left)
    throw new Error(`The ${kind} target is not the visible reading content`)
  const before = target.getBoundingClientRect().top
  resolveFile(image("above.svg"))
  await until(() => !!fixture.querySelector<HTMLImageElement>('img[alt="above.svg"]')?.naturalHeight)
  await frames(12)
  const drift = Math.abs(target.getBoundingClientRect().top - before)
  check(drift <= 2, `${kind} retains its visible position through media loading above it (${windowed ? "virtual" : "flow"}, ${drift.toFixed(2)}px drift)`)
  if (kind === "diagram" || inlineDocument && kind !== "har") {
    const source = Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === "Source")!
    source.click()
    await until(() => !!target.querySelector("pre"), "source view")
    await frames(8)
    check(Math.abs(target.getBoundingClientRect().top - before) <= 2, `${kind} keeps its position when switching to source`)
    const preview = Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === (kind === "diagram" ? "Diagram" : "Preview"))!
    preview.click()
    if (kind === "diagram") await until(() => !!target.querySelector<HTMLImageElement>("img")?.naturalHeight, "restored diagram")
    await frames(12)
    check(Math.abs(target.getBoundingClientRect().top - before) <= 2, `${kind} keeps its position when its preview remounts`)
  }
  show([{ id: "audit-other", system: [], response: [{ id: "audit-other-answer", role: "assistant", blocks: [{ type: "text", text: "Another conversation." }] }] }], "audit-other")
  await frames(8)
  show(exchanges, `render-${kind}-${windowed}`)
  await frames(8)
  if (inlineDocument) fixture.querySelector<HTMLButtonElement>(`${selector} button[aria-expanded]`)!.click()
  if (kind === "diff" || kind === "tool") fixture.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click()
  await until(() => !!fixture.querySelector(selector), "restored rendering target")
  const restored = fixture.querySelector<HTMLElement>(selector)!
  if (kind === "diagram") await until(() => !!restored.querySelector<HTMLImageElement>("img")?.naturalHeight, "reopened diagram")
  if (kind === "html") await until(() => !!restored.querySelector("iframe"), "reopened HTML")
  if (kind === "pdf") await until(() => !!restored.querySelector('[aria-busy="false"] canvas'), "reopened PDF canvas")
  if (kind === "har") await until(() => !!restored.querySelector('[aria-label="Filter diagnostic rows"]'), "reopened diagnostic rendering")
  await frames(12)
  const returnDrift = Math.abs(restored.getBoundingClientRect().top - before)
  check(returnDrift <= 2, `${kind} restores its reading position after switching chats (${windowed ? "virtual" : "flow"}, ${returnDrift.toFixed(2)}px drift)`)
}

function pdfFixture() {
  const stream = "BT /F1 20 Tf 40 520 Td (PDF scroll fixture) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return `data:application/pdf;base64,${btoa(pdf)}`
}

async function collapsibleAbove(windowed: boolean, kind: string) {
  const prose = Array.from({ length: 24 }, (_, i) => `Expandable paragraph ${i}. Content below a section retains its position while the section opens and closes.`).join("\n\n")
  const calls: Exchange["response"][number]["blocks"] = Array.from({ length: kind === "work" ? 3 : 1 }, (_, i) => [
    { type: "toolCall" as const, id: `toggle-tool-${i}`, name: "fixture_tool", arguments: {} },
    { type: "toolResult" as const, id: `toggle-tool-${i}`, name: "fixture_tool", text: prose },
  ]).flat()
  const blocks: Exchange["response"][number]["blocks"] = kind === "reasoning" ? [{ type: "thinking", thinking: prose }]
    : kind === "plan" ? [{ type: "proposed-plan", id: "toggle-plan", status: "proposed", text: "# Proposed plan\n\n" + prose }]
    : kind === "notes" ? [] : calls
  if (kind === "reasoning") prefsStore.set({ showThinking: true })
  const exchanges: Exchange[] = [{ id: `toggle-${kind}`, system: kind === "notes" ? [{ after: 0, message: { id: "toggle-note", role: "system", blocks: [], note: { label: "Audit notice", tone: "warning", body: prose } } }] : [], response: [
    { id: "toggle-section", role: "assistant", blocks },
    { id: "toggle-tail", role: "assistant", blocks: [{ type: "text", text: prose }] },
  ] }]
  if (windowed) exchanges.unshift(...Array.from({ length: 200 }, (_, i) => ({ id: `toggle-before-${i}`, system: [], response: [{ id: `toggle-answer-${i}`, role: "assistant" as const, blocks: [{ type: "text" as const, text: `Earlier answer ${i}.` }] }] })))
  show(exchanges, `toggle-${kind}-${windowed}`)
  await frames(12)
  const scroller = fixture.querySelector<HTMLDivElement>(".scroll-fade-scroller")!
  const paragraph = Array.from(fixture.querySelectorAll("p")).findLast(item => item.textContent?.startsWith("Expandable paragraph 2."))!
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
  scroller.scrollTop += paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 220
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await frames(8)
  scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(4)
  const before = paragraph.getBoundingClientRect().top
  const toggle = kind === "plan" ? Array.from(fixture.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === "Show full plan")!
    : kind === "work" ? fixture.querySelector<HTMLButtonElement>('[data-work-summary]')!
    : fixture.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!
  const activate = () => {
    toggle.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }))
    toggle.click()
    toggle.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }))
  }
  for (const action of ["opening", "closing"]) {
    activate()
    let drift = 0
    for (let frame = 0; frame < 20; frame++) {
      await paintedFrame()
      drift = Math.max(drift, Math.abs(paragraph.getBoundingClientRect().top - before))
    }
    check(drift <= 2, `${action} ${kind} above the reader retains the visible paragraph throughout layout (${windowed ? "virtual" : "flow"}, ${drift.toFixed(2)}px maximum drift)`)
  }
}

async function balancedMedia(windowed: boolean) {
  const short = image("balanced.svg", 300)
  const tall = image("balanced.svg", 600)
  await Promise.all([short, tall].map(async file => {
    const preload = new Image()
    preload.src = file.previewUrl!
    await preload.decode()
  }))
  const exchanges = (swap: boolean): Exchange[] => [{ id: "balanced-turn", system: [], response: [{ id: "balanced-answer", role: "assistant", blocks: [{ type: "text", text:
    `![above.svg](${(swap ? tall : short).previewUrl!})\n\nReading between two images. This paragraph must stay in place even when their height changes cancel out.\n\n![below.svg](${(swap ? short : tall).previewUrl!})\n\n` +
    Array.from({ length: 24 }, (_, i) => `Balanced tail ${i}. Room beneath both images.`).join("\n\n") }],
  }] }]
  const withEarlier = (items: Exchange[]) => windowed ? [...Array.from({ length: 200 }, (_, i) => ({ id: `balanced-before-${i}`, system: [], response: [{ id: `balanced-answer-${i}`, role: "assistant" as const, blocks: [{ type: "text" as const, text: `Earlier answer ${i}.` }] }] })), ...items] : items
  show(withEarlier(exchanges(false)), `balanced-${windowed}`)
  await frames(8)
  const scroller = fixture.querySelector<HTMLDivElement>(".scroll-fade-scroller")!
  const place = async (element: Element, offset: number) => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
    await frames(8)
  }
  for (const name of ["above.svg", "below.svg"]) {
    await until(() => !!fixture.querySelector(`img[alt="${name}"]`), `mounted ${name}`)
    const img = fixture.querySelector<HTMLImageElement>(`img[alt="${name}"]`)!
    await place(img, 40)
    await until(() => img.naturalHeight > 0, name)
  }
  const paragraph = Array.from(fixture.querySelectorAll("p")).find(item => item.textContent?.startsWith("Reading between two images."))!
  await place(paragraph, new URL(location.href).searchParams.has("offCenter") ? 380 : 220)
  scroller.dispatchEvent(new Event("scrollend", { bubbles: true }))
  await frames(4)
  const before = paragraph.getBoundingClientRect().top
  const turn = fixture.querySelector('[data-exchange="balanced-turn"]')!
  if (new URL(location.href).searchParams.has("selecting")) {
    paragraph.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }))
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    document.getSelection()?.addRange(range)
  }
  const height = turn.getBoundingClientRect().height
  show(withEarlier(exchanges(true)), `balanced-${windowed}`)
  await until(() => fixture.querySelector<HTMLImageElement>('img[alt="above.svg"]')!.naturalHeight === 600 && fixture.querySelector<HTMLImageElement>('img[alt="below.svg"]')!.naturalHeight === 300, "swapped image sizes")
  await frames(12)
  check(Math.abs(turn.getBoundingClientRect().height - height) <= 2, "opposite media resizes leave the turn's total height unchanged")
  const drift = Math.abs(paragraph.getBoundingClientRect().top - before)
  paragraph.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }))
  document.getSelection()?.removeAllRanges()
  check(drift <= 2, `opposite media resizes retain the paragraph between them (${windowed ? "virtual" : "flow"}, ${drift.toFixed(2)}px drift)`)
}

button.onclick = async () => {
  button.disabled = true
  output.textContent = "Running media scroll checks…"
  try {
    const windowed = new URL(location.href).searchParams.has("virtual")
    const audit = new URL(location.href).searchParams.get("audit")
    if (audit === "balanced") await balancedMedia(windowed)
    else if (audit && ["reasoning", "work", "notes", "plan", "toggle-tool"].includes(audit)) await collapsibleAbove(windowed, audit)
    else if (audit) await renderingAnchor(windowed, audit)
    else {
      await mediaAnchor(windowed)
      await collectionAnchor(windowed)
    }
    output.textContent += "\nAll media scroll checks passed."
  } catch (error) { output.textContent += `\nFAIL ${error instanceof Error ? error.message : String(error)}` }
  finally { button.disabled = false }
}
