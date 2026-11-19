import { z } from "zod"
import { highlightCode } from "./highlight-code"
import type { HighlightReply } from "./highlight-client"

const input = z.object({ source: z.string(), language: z.string() })
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const port = event.ports[0]
  if (!port) return
  const reply = (message: HighlightReply) => {
    port.postMessage(message)
    port.close()
  }
  let asked: z.infer<typeof input>
  try {
    asked = input.parse(event.data)
  } catch {
    return reply({ ok: false })
  }
  // Only what a line is drawn from crosses back: a token's words and its colour.
  highlightCode(asked.source, asked.language).then(
    (lines) => reply({ ok: true, lines: lines.map((line) => line.map((token) => ({ content: token.content, color: token.color }))) }),
    () => reply({ ok: false })
  )
})
