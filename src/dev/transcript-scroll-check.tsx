// Explicit fixture page: /scripts/transcript-scroll-browser.html. Never imported by Mako.
import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { toExchanges } from "@/lib/exchanges"
import type { ChatMessage } from "@/lib/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()

let seed = 7
const random = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!

const SENTENCES = [
  "The scroller keeps its own anchor while turns above the reading position change height.",
  "Placeholders stand in for turns the engine has not laid out, so their sizes are guesses until they render.",
  "A reader scrolling upward meets those guesses one turn at a time, and each correction moves the column.",
  "The virtualizer measures rows as they mount and reconciles the offset it owns against the real layout.",
  "Paging prepends thirty turns at once and restores the first visible exchange to the same offset.",
  "When the stream ends, the paragraphs of the finished answer switch to estimated intrinsic sizes.",
  "None of this is visible when every turn is short; it shows in long sessions with code and tables.",
]

function paragraph(sentences: number) {
  return Array.from({ length: sentences }, () => pick(SENTENCES)).join(" ")
}

function code(lines: number) {
  return [
    "```ts",
    ...Array.from({ length: lines }, (_, index) => `const value${index} = compute(${index}, "${pick(["alpha", "beta", "gamma"])}")`),
    "```",
  ].join("\n")
}

function table(rows: number) {
  return [
    "| File | Change | Lines |",
    "| --- | --- | --- |",
    ...Array.from({ length: rows }, (_, index) => `| src/file-${index}.ts | ${pick(["anchor", "measure", "restore"])} | ${index * 7} |`),
  ].join("\n")
}

function answer(index: number) {
  const parts: string[] = []
  const blocks = 1 + Math.floor(random() * 9)
  for (let block = 0; block < blocks; block += 1) {
    const kind = random()
    if (kind < 0.45) parts.push(paragraph(4 + Math.floor(random() * 9)))
    else if (kind < 0.6) parts.push(code(6 + Math.floor(random() * 40)))
    else if (kind < 0.7) parts.push(table(3 + Math.floor(random() * 12)))
    else if (kind < 0.85) parts.push(Array.from({ length: 3 + Math.floor(random() * 6) }, () => `- ${pick(SENTENCES)}`).join("\n"))
    else parts.push(`## Step ${index}.${block}\n\n${paragraph(2)}`)
  }
  return parts.join("\n\n")
}

function conversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  const start = Date.now() - turns * 120_000
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      id: `u${index}`,
      role: "user",
      timestamp: start + index * 120_000,
      blocks: [{ type: "text", text: `Question ${index}: ${paragraph(1 + Math.floor(random() * 3))}` }],
    })
    const tools = Math.floor(random() * 4)
    messages.push({
      id: `a${index}`,
      role: "assistant",
      timestamp: start + index * 120_000 + 30_000,
      model: "claude-opus-5",
      blocks: [
        ...Array.from({ length: tools }, (_, tool) => [
          { type: "toolCall" as const, id: `t${index}-${tool}`, name: "bash", arguments: { command: `rg -n anchor src/${tool}` } },
          { type: "toolResult" as const, id: `t${index}-${tool}`, name: "bash", text: Array.from({ length: 4 }, (_, line) => `src/a${line}.ts:${line}: anchor`).join("\n") },
        ]).flat(),
        { type: "text" as const, text: answer(index) },
      ],
    })
  }
  return messages
}

const params = new URL(location.href).searchParams
const TURNS = Number(params.get("turns") ?? 90)
const base = conversation(TURNS)

interface ProbeState {
  messages: ChatMessage[]
  streamingId?: string
}

let setProbe: (update: (state: ProbeState) => ProbeState) => void = () => {}

export function Probe() {
  const [state, set] = useState<ProbeState>({ messages: base })
  useEffect(() => {
    setProbe = set
    return () => { setProbe = () => {} }
  }, [set])
  const exchanges = toExchanges(state.messages)
  return (
    <TooltipProvider>
      <main className="agent-surface relative isolate flex h-screen flex-col overflow-hidden">
        <ConversationTimeline
          identity="scroll-probe"
          exchanges={exchanges}
          streamingId={state.streamingId}
          empty={null}
        />
      </main>
    </TooltipProvider>
  )
}

declare global {
  interface Window {
    probe: {
      /** Starts a new turn whose answer streams in `chunks` pieces. */
      startTurn: () => string
      appendToTurn: (text: string) => void
      finishTurn: () => void
    }
  }
}

window.probe = {
  startTurn() {
    const index = Date.now()
    setProbe((state) => ({
      streamingId: `u${index}`,
      messages: [
        ...state.messages,
        { id: `u${index}`, role: "user", timestamp: Date.now(), blocks: [{ type: "text", text: "Stream a long answer." }] },
        {
          id: `a${index}`,
          role: "assistant",
          timestamp: Date.now(),
          model: "claude-opus-5",
          blocks: [
            ...Array.from({ length: 5 }, (_, tool) => [
              { type: "toolCall" as const, id: `live-${index}-${tool}`, name: "bash", arguments: { command: `rg -n anchor src/live-${tool}` } },
              { type: "toolResult" as const, id: `live-${index}-${tool}`, name: "bash", text: "src/a.ts:1: anchor" },
            ]).flat(),
            { type: "text", text: "" },
          ],
        },
      ],
    }))
    return `u${index}`
  },
  appendToTurn(text) {
    setProbe((state) => {
      const messages = state.messages.slice()
      const last = messages.at(-1)!
      const block = last.blocks.at(-1)
      if (block?.type !== "text") return state
      messages[messages.length - 1] = { ...last, blocks: [...last.blocks.slice(0, -1), { ...block, text: block.text + text }] }
      return { ...state, messages }
    })
  },
  finishTurn() {
    setProbe((state) => ({ ...state, streamingId: undefined }))
  },
}

createRoot(document.getElementById("root")!).render(<Probe />)
