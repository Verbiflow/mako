import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { gunzipSync } from "node:zlib"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.ts"

/**
 * A stand-in for a model provider that answers from a script, so a real
 * harness CLI runs a real turn (reasoning, text, a tool call and its result,
 * a closing answer) without an account, a network or a model. Speaks
 * OpenAI Chat Completions streaming; any other POST is refused, which sends
 * a harness that tries the Responses API first back to Chat Completions.
 */

export interface ScriptedReply {
  reasoning?: string
  text?: string
  call?: { id: string; name: string; arguments: JsonObject }
}

const ChatRequest = z.object({
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).optional(),
  messages: z.array(z.object({ role: z.string() }).loose()),
}).loose()
export type ChatRequest = z.infer<typeof ChatRequest>

export interface ScriptedModelOptions {
  /** GETs whose path starts with a key, answered with its JSON. */
  answers?: ReadonlyMap<string, string>
  /** The reply to a conversation request: one that carries tools. */
  reply: (request: ChatRequest) => ScriptedReply | undefined
  /** What a side request (a title, a summary) gets. */
  aside?: string
}

export async function scriptedModel(options: ScriptedModelOptions) {
  /** Every request, and whether the script had a step for it. */
  const requests: { path: string; conversation: boolean; unscripted?: boolean }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const path = request.url ?? "/"
      if (request.method === "GET") {
        const answer = [...options.answers ?? []].find(([prefix]) => path.startsWith(prefix))?.[1]
        response.setHeader("content-type", "application/json")
        response.statusCode = answer === undefined ? 404 : 200
        return void response.end(answer ?? "{}")
      }
      const raw = Buffer.concat(chunks)
      const text = (request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8")
      const body = path.endsWith("/chat/completions") ? ChatRequest.safeParse(safeJson(text)).data : undefined
      if (!body) {
        requests.push({ path: `${request.method} ${path}`, conversation: false })
        response.statusCode = 400
        response.setHeader("content-type", "application/json")
        return void response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "The scripted model answers Chat Completions only" } }))
      }
      const conversation = Boolean(body.tools?.length)
      const scripted = conversation ? options.reply(body) : { text: options.aside ?? "Notes" }
      requests.push({ path: `${request.method} ${path}`, conversation, unscripted: scripted ? undefined : true })
      const reply = scripted ?? { text: "The script has no more steps." }
      if (body.stream === false) {
        response.setHeader("content-type", "application/json")
        return void response.end(JSON.stringify(completion(reply)))
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      for (const chunk of streamed(reply)) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end("data: [DONE]\n\n")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port reports its address as an AddressInfo.
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

function safeJson(text: string): JsonValue | undefined {
  try {
    const value: JsonValue = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

const MODEL = "scripted"
const USAGE = { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 }

function streamed(reply: ScriptedReply): JsonObject[] {
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: JsonObject, finish: string | null = null): JsonObject =>
    ({ id: "scripted", object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })
  const chunks: JsonObject[] = [chunk({ role: "assistant", content: "" })]
  for (const part of words(reply.reasoning)) chunks.push(chunk({ reasoning_content: part }))
  for (const part of words(reply.text)) chunks.push(chunk({ content: part }))
  if (reply.call)
    chunks.push(chunk({ tool_calls: [{ index: 0, id: reply.call.id, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.arguments) } }] }))
  chunks.push(chunk({}, reply.call ? "tool_calls" : "stop"))
  chunks.push({ id: "scripted", object: "chat.completion.chunk", created, model: MODEL, choices: [], usage: USAGE })
  return chunks
}

function completion(reply: ScriptedReply): JsonObject {
  const message: JsonObject = { role: "assistant", content: reply.text ?? "" }
  if (reply.call) message.tool_calls = [{ id: reply.call.id, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.arguments) } }]
  return { id: "scripted", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: reply.call ? "tool_calls" : "stop" }], usage: USAGE }
}

/** Text in a few deltas, the way a model streams it. */
function words(text: string | undefined): string[] {
  if (!text) return []
  return text.match(/\S+\s*/g) ?? [text]
}
