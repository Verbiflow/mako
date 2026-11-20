import { useState } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { Prose } from "../src/components/transcript/markdown"
import { settledProse } from "../src/components/transcript/settled-prose"
import { TranscriptSourceContext } from "../src/components/transcript/source-context"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { installMockBridge } from "../src/dev/mock-bridge"
import "../src/index.css"

/**
 * The page `test-prose-settle-ui.mjs` drives: a long agent reply streamed into the transcript's real `Prose`, the last
 * stretch of it a few words at a time, then settled. Main-thread parses are counted by the probe that stands in for
 * `react-markdown` (`performance-markdown-probe.tsx`).
 */
installMockBridge()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function rng(seed: number) {
  let state = seed >>> 0
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
const WORDS = "the host keeps a copy of each turn so a reload draws the same answer without asking the provider again while the runtime streams events through the bridge".split(" ")

/** A deterministic agent-style reply of about `chars` characters: headings, prose, lists, tables, quotes and code. */
function reply(chars: number): string {
  const r = rng(7)
  const word = () => WORDS[Math.floor(r() * WORDS.length)]!
  const sentence = () => {
    const words = Array.from({ length: 8 + Math.floor(r() * 12) }, (_, index) =>
      index === 3 ? "`src/components/transcript/markdown.tsx`" : index === 7 ? `**${word()}**` : word())
    return words.join(" ") + "."
  }
  const blocks = ["# Streaming answer", sentence()]
  for (let index = 1; blocks.join("\n\n").length < chars; index++) {
    const kind = r()
    if (index % 7 === 0) blocks.push(`## Section ${index % 3}`)
    else if (kind < 0.35) blocks.push(`${sentence()} ${sentence()}`)
    else if (kind < 0.5) blocks.push(`- ${sentence()}\n  - ${sentence()}\n- ${sentence()}`)
    else if (kind < 0.6) blocks.push(`| Path | Lines |\n| --- | ---: |\n| \`src/app.ts\` | ${index} |\n| \`src/b.ts\` | ${index + 1} |`)
    else if (kind < 0.67) blocks.push(`> ${sentence()}`)
    else blocks.push("```ts\n" + Array.from({ length: 6 }, (_, line) => `export const value${index}x${line} = ${line} // ${word()}`).join("\n") + "\n```")
  }
  return blocks.join("\n\n")
}

const shell = (child: React.ReactNode) => (
  <TooltipProvider>
    <TranscriptSourceContext value={{ threadPath: "/fixture/prose-settle" }}>
      <div style={{ width: 760, height: 860, overflow: "auto", padding: 16 }}>{child}</div>
    </TranscriptSourceContext>
  </TooltipProvider>
)

let text = ""
let set: (state: { text: string; streaming: boolean }) => void = () => {}
let root: Root | undefined
const longTasks: number[] = []
new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push(entry.duration))).observe({ type: "longtask" })

function Host({ initial }: { initial: string }) {
  const [state, setState] = useState({ text: initial, streaming: true })
  set = setState
  return <Prose text={state.text} streaming={state.streaming} answerId="settle" />
}

const prose = () => document.querySelector<HTMLElement>("#root .mako-prose")

/**
 * The prose's markup, with each inline file preview's inside left out: a preview reads its file when it's first
 * scrolled near, and one mounted while the answer streamed may not have yet, which is the preview's state, not the
 * Markdown's.
 */
function markup(element: Element | null | undefined): string {
  const copy = element?.cloneNode(true)
  if (!(copy instanceof Element)) return ""
  for (const preview of copy.querySelectorAll("[data-inline-file-preview]")) preview.replaceChildren()
  return copy.innerHTML
}

declare global {
  interface Window {
    proseSettle: {
      prepare(chars: number, tail: number): Promise<{ chars: number }>
      stream(chunk: number): Promise<{ chunks: number }>
      settle(): Promise<{ syncMs: number; mainParses: number[] }>
      whole(): Promise<{ byWorker: boolean; sameAsFresh: boolean; difference?: { settled: string; fresh: string }; longTasks: number[] }>
    }
  }
}

let start = 0
window.proseSettle = {
  async prepare(chars, tail) {
    text = reply(chars)
    start = text.length - tail
    root = createRoot(document.getElementById("root")!)
    flushSync(() => root!.render(shell(<Host initial={text.slice(0, start)} />)))
    // What mounting starts finishes before the stream is measured: its fonts, and whatever the mounted answer does
    // next on its own (previews found, files read), until the page has been still for half a second.
    await document.fonts.ready
    let changed = performance.now()
    const changes = new MutationObserver(() => (changed = performance.now()))
    changes.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    for (const end = performance.now() + 15_000; performance.now() - changed < 500 && performance.now() < end; ) await sleep(100)
    changes.disconnect()
    await sleep(100)
    return { chars: text.length }
  },
  async stream(chunk) {
    let chunks = 0
    for (let at = start; at < text.length; ) {
      at = Math.min(text.length, at + chunk)
      flushSync(() => set({ text: text.slice(0, at), streaming: true }))
      chunks += 1
      await sleep(8)
    }
    await sleep(300)
    return { chunks }
  },
  async settle() {
    globalThis.performanceAuditParses = []
    longTasks.length = 0
    const started = performance.now()
    flushSync(() => set({ text, streaming: false }))
    void document.body.offsetHeight
    const syncMs = performance.now() - started
    const mainParses = globalThis.performanceAuditParses.map((entry) => entry.chars)
    globalThis.performanceAuditParses = undefined
    return { syncMs, mainParses }
  },
  async whole() {
    for (let waited = 0; waited < 20_000 && !prose()?.hasAttribute("data-prose-worker"); waited += 50) await sleep(50)
    await sleep(1_000)
    const byWorker = prose()?.hasAttribute("data-prose-worker") ?? false
    const settledHtml = markup(prose())
    const settling = [...longTasks]
    // Drawn anew, parsed whole on the page: not the settled answer's own elements, kept for a remount.
    settledProse.clear()
    const fresh = document.createElement("div")
    document.body.append(fresh)
    const freshRoot = createRoot(fresh)
    flushSync(() => freshRoot.render(shell(<Prose text={text} streaming={false} answerId="settle" />)))
    await sleep(1_000)
    const freshHtml = markup(fresh.querySelector(".mako-prose"))
    const sameAsFresh = settledHtml === freshHtml
    let at = 0
    while (!sameAsFresh && at < settledHtml.length && settledHtml[at] === freshHtml[at]) at += 1
    const difference = sameAsFresh ? undefined : { settled: settledHtml.slice(Math.max(0, at - 300), at + 300), fresh: freshHtml.slice(Math.max(0, at - 300), at + 300) }
    freshRoot.unmount()
    fresh.remove()
    return { byWorker, sameAsFresh, difference, longTasks: settling }
  },
}
document.title = "ready"
