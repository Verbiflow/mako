import { z } from "zod"
import { parseProse, parseSettledProse, type ProseParseReply } from "./parsed-markdown"

const input = z.object({
  text: z.string(),
  settled: z.object({ previewedFiles: z.array(z.string()).optional() }).optional(),
})
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const port = event.ports[0]
  if (!port) return
  let reply: ProseParseReply
  try {
    const { text, settled } = input.parse(event.data)
    reply = { ok: true, tree: settled ? parseSettledProse(text, settled.previewedFiles) : parseProse(text) }
  } catch {
    reply = { ok: false }
  }
  port.postMessage(reply)
  port.close()
})
