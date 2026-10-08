import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { gunzipSync } from "node:zlib"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.ts"

/**
 * A stand-in for a model provider that answers from a script, so a real
 * harness CLI runs a real turn (reasoning, text, a tool call and its result,
 * a closing answer) without an account, a network or a model. Speaks the
 * three wires Mako's harnesses use, each streamed as its provider streams it:
 * OpenAI Chat Completions (`/chat/completions`), Anthropic Messages
 * (`/messages`) and OpenAI Responses (`/responses`, over HTTP or the
 * WebSocket Codex opens first). Any other request is refused.
 */

export interface ScriptedReply {
  reasoning?: string
  text?: string
  /** A function tool takes `arguments`; a freeform one (Codex's `apply_patch`) takes `input` text. */
  call?: { id: string; name: string } & ({ arguments: JsonObject } | { input: string })
  /** The request fails with this status and the wire's own error shape instead. */
  fail?: { status: number; message: string }
  /** A Responses `compaction` item's content, which only the provider reads. */
  compaction?: string
}

type Wire = "chat" | "messages" | "responses"

const ModelRequest = z.object({ stream: z.boolean().optional(), tools: z.array(z.json()).optional(), tool_choice: z.json().optional(), input: z.json().optional() }).loose()
/**
 * A Responses request on the WebSocket; `generate: false` only warms the
 * connection. One that continues `previous_response_id` keeps the tools of
 * the request it continues and sends none: Codex 0.159.3 does for gpt-6-sol.
 */
const SocketRequest = z.object({
  type: z.literal("response.create"),
  tools: z.array(z.json()).optional(),
  tool_choice: z.json().optional(),
  input: z.json().optional(),
  generate: z.boolean().optional(),
  previous_response_id: z.string().optional(),
}).loose()

/**
 * Tools a Responses request lists in its input instead of `tools`, each
 * namespace's flattened: Codex 0.159.3 sends gpt-6-sol's this way.
 */
const AdditionalTools = z.object({ type: z.literal("additional_tools"), tools: z.array(z.json()) }).loose()
const Namespace = z.object({ type: z.literal("namespace"), tools: z.array(z.json()) }).loose()

/**
 * Codex 0.159.3's remote compaction asks with a `compaction_trigger` input
 * item and takes exactly one `compaction` item back; the step's text becomes
 * its content.
 */
const CompactionTrigger = z.object({ type: z.literal("compaction_trigger") }).loose()
function compacting(input: JsonValue | undefined, reply: ScriptedReply): ScriptedReply {
  const asked = Array.isArray(input) && input.some((item) => CompactionTrigger.safeParse(item).success)
  return asked && reply.text ? { compaction: reply.text } : reply
}

/** The tools `body` offers the model, wherever its wire lists them. */
function offeredTools(body: { tools?: JsonValue[]; input?: JsonValue }): JsonValue[] | undefined {
  const listed = (Array.isArray(body.input) ? body.input : []).flatMap((item) => AdditionalTools.safeParse(item).data?.tools ?? [])
  const tools = [...body.tools ?? [], ...listed].flatMap((tool) => Namespace.safeParse(tool).data?.tools ?? [tool])
  return tools.length ? tools : undefined
}

/** A tool choice that names one tool: Responses and Anthropic put the name on it, Chat Completions under `function`. */
const NamedChoice = z.object({ name: z.string() }).loose()
const FunctionChoice = z.object({ function: z.object({ name: z.string() }).loose() }).loose()
/** A tool definition's name and the arguments it requires, in any of the three wires' shapes. */
const ToolDefinition = z.object({
  name: z.string().optional(),
  function: z.object({ name: z.string(), parameters: z.json().optional() }).loose().optional(),
  parameters: z.json().optional(),
  input_schema: z.json().optional(),
}).loose()
const Required = z.object({ required: z.array(z.string()) }).loose()

/**
 * A request that forces one named tool is a side request (Grok titles a
 * session this way): it is answered with that tool, each required argument
 * set to the aside text, and takes no step of the script.
 */
function forcedReply(choice: JsonValue | undefined, tools: readonly JsonValue[] | undefined, aside: string): ScriptedReply | undefined {
  const name = NamedChoice.safeParse(choice).data?.name ?? FunctionChoice.safeParse(choice).data?.function.name
  if (!name) return undefined
  const tool = (tools ?? []).map((candidate) => ToolDefinition.safeParse(candidate).data).find((candidate) => (candidate?.function?.name ?? candidate?.name) === name)
  const required = Required.safeParse(tool?.function?.parameters ?? tool?.parameters ?? tool?.input_schema).data?.required ?? []
  return { call: { id: "call_aside", name, arguments: Object.fromEntries(required.map((field) => [field, aside])) } }
}

export interface ScriptedModelOptions {
  /** GETs whose path starts with a key, answered with its JSON. */
  answers?: ReadonlyMap<string, string>
  /** The reply to a conversation request, one that carries tools, given the request's text. */
  reply: (heard: string) => ScriptedReply | undefined
  /** What a side request (a title, a summary) gets. */
  aside?: string
  /** A side request that carries the conversation's tools without forcing one, told apart by what it asks. */
  side?: (heard: string) => boolean
}

export async function scriptedModel(options: ScriptedModelOptions) {
  /** Every request, and whether the script had a step for it. */
  const requests: { path: string; conversation: boolean; unscripted?: boolean }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const path = request.url ?? "/"
      const route = new URL(path, "http://scripted").pathname
      if (request.method === "GET") {
        const answer = [...options.answers ?? []].find(([prefix]) => path.startsWith(prefix))?.[1]
        response.statusCode = answer === undefined ? 404 : 200
        return void json(response, answer ?? "{}")
      }
      const raw = Buffer.concat(chunks)
      const text = (request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8")
      if (route.endsWith("/messages/count_tokens")) {
        requests.push({ path: `${request.method} ${path}`, conversation: false })
        return void json(response, JSON.stringify({ input_tokens: USAGE.input }))
      }
      const wire: Wire | undefined = route.endsWith("/chat/completions") ? "chat" : route.endsWith("/messages") ? "messages" : route.endsWith("/responses") ? "responses" : undefined
      const body = wire && ModelRequest.safeParse(safeJson(text)).data
      if (!wire || !body) {
        requests.push({ path: `${request.method} ${path}`, conversation: false })
        response.statusCode = 400
        return void json(response, JSON.stringify({ error: { type: "invalid_request_error", message: "The scripted model answers Chat Completions, Anthropic Messages and OpenAI Responses only" } }))
      }
      const reply = compacting(body.input, answer(`${request.method} ${path}`, { tools: offeredTools(body), tool_choice: body.tool_choice }, text))
      if (reply.fail) {
        response.statusCode = reply.fail.status
        return void json(response, JSON.stringify(failure(wire, reply.fail.message)))
      }
      const streams = wire === "chat" ? body.stream !== false : body.stream === true
      if (!streams) return void json(response, JSON.stringify(WHOLE[wire](reply)))
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      for (const event of STREAMED[wire](reply)) {
        const named = wire === "chat" ? "" : `event: ${z.object({ type: z.string() }).parse(event).type}\n`
        response.write(`${named}data: ${JSON.stringify(event)}\n\n`)
      }
      response.end(wire === "chat" ? "data: [DONE]\n\n" : "")
    })
  })
  /** The script's next step for a conversation request, the aside for any other. */
  const answer = (path: string, body: { tools?: JsonValue[]; tool_choice?: JsonValue }, heard: string): ScriptedReply => {
    const aside = options.aside ?? "Notes"
    const forced = forcedReply(body.tool_choice, body.tools, aside)
    const conversation = Boolean(body.tools?.length) && !forced && !options.side?.(heard)
    const scripted = conversation ? options.reply(heard) : forced ?? { text: aside }
    requests.push({ path, conversation, unscripted: scripted ? undefined : true })
    return scripted ?? { text: "The script has no more steps." }
  }
  /** Upgraded sockets, which `closeAllConnections` leaves open. */
  const sockets = new Set<Duplex>()
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    const path = request.url ?? "/"
    if (!new URL(path, "http://scripted").pathname.endsWith("/responses"))
      return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n")
    let tools: JsonValue[] | undefined
    const send = webSocket(request, socket, (text) => {
      const body = SocketRequest.safeParse(safeJson(text)).data
      if (!body) return void send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The scripted model answers response.create only" } }))
      tools = offeredTools(body) ?? (body.previous_response_id ? tools : undefined)
      if (body.generate === false) {
        const id = Math.random().toString(36).slice(2)
        for (const event of [{ type: "response.created", response: responseObject(id, "in_progress", []) }, { type: "response.completed", response: responseObject(id, "completed", []) }]) send(JSON.stringify(event))
        return
      }
      const reply = compacting(body.input, answer(`WS ${path}`, { tools, tool_choice: body.tool_choice }, text))
      if (reply.fail) return void send(JSON.stringify({ type: "error", status: reply.fail.status, error: { type: "server_error", message: reply.fail.message } }))
      for (const event of responsesStreamed(reply)) send(JSON.stringify(event))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port reports its address as an AddressInfo.
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/**
 * Accepts a WebSocket and hands each text message to `heard`; the returned
 * function sends one. Answers pings and closes, and offers no extensions,
 * so frames arrive uncompressed.
 */
function webSocket(request: IncomingMessage, socket: Duplex, heard: (text: string) => void): (text: string) => void {
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const frame = (opcode: number, payload: Buffer) => {
    const length = payload.length
    const head = length < 126 ? Buffer.from([0x80 | opcode, length])
      : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size })()])
    if (!socket.destroyed) socket.write(Buffer.concat([head, payload]))
  }
  let buffer = Buffer.alloc(0)
  let parts: Buffer[] = []
  socket.on("error", () => socket.destroy())
  socket.on("end", () => socket.destroy())
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const final = (buffer[0]! & 0x80) !== 0
      const opcode = buffer[0]! & 0x0f
      let length = buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (buffer[1]! & 0x80) !== 0
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (mask) for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!
      buffer = buffer.subarray(offset + length)
      if (opcode === 8) {
        frame(8, payload.subarray(0, 2))
        return void socket.end()
      }
      if (opcode === 9) frame(10, payload)
      if (opcode !== 0 && opcode !== 1) continue
      parts.push(payload)
      if (!final) continue
      const text = Buffer.concat(parts).toString("utf8")
      parts = []
      heard(text)
    }
  })
  return (text) => frame(1, Buffer.from(text, "utf8"))
}

function json(response: ServerResponse, text: string): void {
  response.setHeader("content-type", "application/json")
  response.end(text)
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
const USAGE = { input: 1200, output: 40 }

function failure(wire: Wire, message: string): JsonObject {
  return wire === "messages" ? { type: "error", error: { type: "api_error", message } } : { error: { type: "server_error", message } }
}

type Call = NonNullable<ScriptedReply["call"]>
const argumentText = (call: Call) => "input" in call ? call.input : JSON.stringify(call.arguments)

/* ------------------------------------------------------- Chat Completions */

function chatStreamed(reply: ScriptedReply): JsonObject[] {
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: JsonObject, finish: string | null = null): JsonObject =>
    ({ id: "scripted", object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })
  const chunks: JsonObject[] = [chunk({ role: "assistant", content: "" })]
  for (const part of words(reply.reasoning)) chunks.push(chunk({ reasoning_content: part }))
  for (const part of words(reply.text)) chunks.push(chunk({ content: part }))
  if (reply.call)
    chunks.push(chunk({ tool_calls: [{ index: 0, id: reply.call.id, type: "function", function: { name: reply.call.name, arguments: argumentText(reply.call) } }] }))
  chunks.push(chunk({}, reply.call ? "tool_calls" : "stop"))
  chunks.push({ id: "scripted", object: "chat.completion.chunk", created, model: MODEL, choices: [], usage: CHAT_USAGE })
  return chunks
}

const CHAT_USAGE = { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output }

function chatWhole(reply: ScriptedReply): JsonObject {
  const message: JsonObject = { role: "assistant", content: reply.text ?? "" }
  if (reply.call) message.tool_calls = [{ id: reply.call.id, type: "function", function: { name: reply.call.name, arguments: argumentText(reply.call) } }]
  return { id: "scripted", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: reply.call ? "tool_calls" : "stop" }], usage: CHAT_USAGE }
}

/* ------------------------------------------------------ Anthropic Messages */

function messageBlocks(reply: ScriptedReply): JsonObject[] {
  const blocks: JsonObject[] = []
  if (reply.reasoning) blocks.push({ type: "thinking", thinking: reply.reasoning, signature: "scripted" })
  if (reply.text) blocks.push({ type: "text", text: reply.text })
  if (reply.call) blocks.push({ type: "tool_use", id: reply.call.id, name: reply.call.name, input: "input" in reply.call ? { input: reply.call.input } : reply.call.arguments })
  return blocks
}

const messageStop = (reply: ScriptedReply) => reply.call ? "tool_use" : "end_turn"
const MESSAGE_USAGE = { input_tokens: USAGE.input, output_tokens: USAGE.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function messagesStreamed(reply: ScriptedReply): JsonObject[] {
  const id = `msg_${Math.random().toString(36).slice(2)}`
  const events: JsonObject[] = [{
    type: "message_start",
    message: { id, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { ...MESSAGE_USAGE, output_tokens: 1 } },
  }]
  messageBlocks(reply).forEach((block, index) => {
    if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })
      for (const part of words(reply.reasoning)) events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } })
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "scripted" } })
    } else if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } })
      for (const part of words(reply.text)) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } })
    } else {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } })
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
    }
    events.push({ type: "content_block_stop", index })
  })
  events.push({ type: "message_delta", delta: { stop_reason: messageStop(reply), stop_sequence: null }, usage: { output_tokens: USAGE.output } })
  events.push({ type: "message_stop" })
  return events
}

function messagesWhole(reply: ScriptedReply): JsonObject {
  return { id: "msg_scripted", type: "message", role: "assistant", model: MODEL, content: messageBlocks(reply), stop_reason: messageStop(reply), stop_sequence: null, usage: MESSAGE_USAGE }
}

/* --------------------------------------------------------- OpenAI Responses */

interface ResponseItem {
  item: JsonObject
  /** The events between its `output_item.added` and `output_item.done`. */
  deltas: (output_index: number) => JsonObject[]
  /** The item as `output_item.added` carries it, before its deltas. */
  opened: JsonObject
}

function responseItems(reply: ScriptedReply, id: string): ResponseItem[] {
  const items: ResponseItem[] = []
  const { reasoning, text, call, compaction } = reply
  if (compaction !== undefined) {
    const item = { type: "compaction", id: `cmp_${id}`, encrypted_content: compaction }
    items.push({ item, opened: item, deltas: () => [] })
  }
  if (reasoning) {
    const item_id = `rs_${id}`
    const item = { type: "reasoning", id: item_id, summary: [{ type: "summary_text", text: reasoning }] }
    items.push({ item, opened: { ...item, summary: [] }, deltas: (output_index): JsonObject[] => [
      { type: "response.reasoning_summary_part.added", item_id, output_index, summary_index: 0, part: { type: "summary_text", text: "" } },
      ...words(reasoning).map((delta) => ({ type: "response.reasoning_summary_text.delta", item_id, output_index, summary_index: 0, delta })),
      { type: "response.reasoning_summary_text.done", item_id, output_index, summary_index: 0, text: reasoning },
    ] })
  }
  if (text) {
    const item_id = `msg_${id}`
    const item = { type: "message", id: item_id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }
    items.push({ item, opened: { ...item, status: "in_progress", content: [] }, deltas: (output_index): JsonObject[] => [
      { type: "response.content_part.added", item_id, output_index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      ...words(text).map((delta) => ({ type: "response.output_text.delta", item_id, output_index, content_index: 0, delta })),
      { type: "response.output_text.done", item_id, output_index, content_index: 0, text },
    ] })
  }
  if (call && "input" in call) {
    const item_id = `ctc_${id}`
    const item = { type: "custom_tool_call", id: item_id, call_id: call.id, name: call.name, input: call.input, status: "completed" }
    items.push({ item, opened: { ...item, input: "", status: "in_progress" }, deltas: (output_index): JsonObject[] => [
      { type: "response.custom_tool_call_input.delta", item_id, output_index, delta: call.input },
      { type: "response.custom_tool_call_input.done", item_id, output_index, input: call.input },
    ] })
  } else if (call) {
    const args = argumentText(call)
    const item_id = `fc_${id}`
    const item = { type: "function_call", id: item_id, call_id: call.id, name: call.name, arguments: args, status: "completed" }
    items.push({ item, opened: { ...item, arguments: "", status: "in_progress" }, deltas: (output_index): JsonObject[] => [
      { type: "response.function_call_arguments.delta", item_id, output_index, delta: args },
      { type: "response.function_call_arguments.done", item_id, output_index, arguments: args },
    ] })
  }
  return items
}

const RESPONSE_USAGE = {
  input_tokens: USAGE.input, input_tokens_details: { cached_tokens: 0 },
  output_tokens: USAGE.output, output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: USAGE.input + USAGE.output,
}

function responseObject(id: string, status: string, output: JsonObject[]): JsonObject {
  return { id: `resp_${id}`, object: "response", created_at: Math.floor(Date.now() / 1000), status, model: MODEL, output, usage: status === "completed" ? RESPONSE_USAGE : null }
}

function responsesStreamed(reply: ScriptedReply): JsonObject[] {
  const id = Math.random().toString(36).slice(2)
  const items = responseItems(reply, id)
  const events: JsonObject[] = [{ type: "response.created", response: responseObject(id, "in_progress", []) }]
  items.forEach(({ item, opened, deltas }, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: opened })
    events.push(...deltas(output_index))
    events.push({ type: "response.output_item.done", output_index, item })
  })
  events.push({ type: "response.completed", response: responseObject(id, "completed", items.map(({ item }) => item)) })
  return events.map((event, sequence_number) => ({ ...event, sequence_number }))
}

function responsesWhole(reply: ScriptedReply): JsonObject {
  const id = Math.random().toString(36).slice(2)
  return responseObject(id, "completed", responseItems(reply, id).map(({ item }) => item))
}

const STREAMED = { chat: chatStreamed, messages: messagesStreamed, responses: responsesStreamed } satisfies Record<Wire, (reply: ScriptedReply) => JsonObject[]>
const WHOLE = { chat: chatWhole, messages: messagesWhole, responses: responsesWhole } satisfies Record<Wire, (reply: ScriptedReply) => JsonObject>

/** Text in a few deltas, the way a model streams it. */
function words(text: string | undefined): string[] {
  if (!text) return []
  return text.match(/\S+\s*/g) ?? [text]
}
