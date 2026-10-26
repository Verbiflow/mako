import { randomUUID } from "node:crypto"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import { USAGE, words, type ScriptedModelOptions, type ScriptedReply, type ScriptedRequest } from "./scripted-model.ts"

/**
 * Windsurf's API server as Devin's CLI speaks to it: Connect over HTTP/1.1,
 * protobuf bodies. Devin takes the server's URL from
 * `WINDSURF_API_SERVER_URL`. The field numbers are the ones Devin.app's
 * bundled protobuf types give (`exa.api_server_pb`, `exa.chat_pb`,
 * `exa.codeium_common_pb`); Devin's own binary carries none.
 *
 * `harness-native-tools.ts` reads the tools out of a request and refuses it;
 * `scriptedWindsurf` answers it from a script, as `scripted-model.ts` answers
 * the other harnesses.
 */

export type ProtoField = { no: number; wire: "varint"; value: number } | { no: number; wire: "bytes"; bytes: Buffer }

/** A protobuf message's varint and length-delimited fields in order; fixed-width ones are skipped. */
export function protoFields(bytes: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let at = 0
  const varint = () => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[at++]
      if (byte === undefined) throw new Error("A protobuf varint ran past its message")
      value += (byte & 127) * 2 ** shift
      if (byte < 128) return value
    }
  }
  while (at < bytes.length) {
    const tag = varint()
    const wire = tag & 7
    const no = Math.floor(tag / 8)
    if (wire === 0) fields.push({ no, wire: "varint", value: varint() })
    else if (wire === 2) {
      const length = varint()
      fields.push({ no, wire: "bytes", bytes: bytes.subarray(at, at + length) })
      at += length
    } else if (wire === 1 || wire === 5) at += wire === 1 ? 8 : 4
    else throw new Error(`Protobuf wire type ${wire} isn't read here`)
  }
  return fields
}

/** Field `no`'s text, the first time it occurs. */
function text(fields: readonly ProtoField[], no: number): string | undefined {
  const found = fields.find((field) => field.no === no)
  return found?.wire === "bytes" ? found.bytes.toString("utf8") : undefined
}

const HeaderValue = z.string().optional().catch(undefined)

/** How a Connect request compressed its message, as its headers name it. */
export function requestEncoding(headers: IncomingHttpHeaders): string | undefined {
  return HeaderValue.parse(headers["connect-content-encoding"]) ?? HeaderValue.parse(headers["grpc-encoding"])
}

/** A compressed Connect message, by the encoding its request names. */
export function decompressed(payload: Buffer, encoding: string | undefined): Buffer {
  switch (encoding) {
    case "gzip": return gunzipSync(payload)
    case "br": return brotliDecompressSync(payload)
    case "zstd": return zstdDecompressSync(payload)
    case "deflate": return inflateSync(payload)
    default: throw new Error(`Devin compressed its model request${encoding ? ` with ${encoding}` : ""}, which isn't read here`)
  }
}

/** The message in a streaming request's one Connect envelope; Devin 3000.11 compresses it. */
export function connectMessage(frame: Buffer, encoding: string | undefined): Buffer {
  if (frame.length < 5) throw new Error("Devin's model request has no Connect frame")
  const payload = frame.subarray(5, 5 + frame.readUInt32BE(1))
  return frame[0]! & 1 ? decompressed(payload, encoding) : payload
}

/**
 * The tools of a `GetChatMessageRequest` (field 10, each an
 * `exa.chat_pb.ChatToolDefinition`: name 1, description 2,
 * json_schema_string 3, is_custom_tool 9), restated as chat-completions tools.
 */
export function windsurfTools(message: Buffer): unknown[] {
  return protoFields(message).flatMap((tool) => {
    if (tool.no !== 10 || tool.wire !== "bytes") return []
    const fields = protoFields(tool.bytes)
    if (fields.some((field) => field.no === 9 && field.wire === "varint" && field.value !== 0))
      throw new Error(`Devin defines ${text(fields, 1)} as a custom-grammar tool, which isn't read here`)
    const schema = text(fields, 3)
    return [{ type: "function", function: { name: text(fields, 1) ?? "", description: text(fields, 2), parameters: schema ? JSON.parse(schema) : undefined } }]
  })
}

/* ------------------------------------------------------------- the writer */

function varint(value: number | bigint): Buffer {
  const bytes: number[] = []
  let rest = BigInt(value)
  do {
    const low = Number(rest & 127n)
    rest >>= 7n
    bytes.push(rest ? low | 128 : low)
  } while (rest)
  return Buffer.from(bytes)
}

/** A message's fields as written; an empty one is left out, as protobuf leaves out a default. */
const write = {
  number: (no: number, value: number): Buffer => value ? Buffer.concat([varint(no * 8), varint(value)]) : Buffer.alloc(0),
  bytes: (no: number, value: Buffer): Buffer => value.length ? Buffer.concat([varint(no * 8 + 2), varint(value.length), value]) : Buffer.alloc(0),
  text: (no: number, value: string | undefined): Buffer => write.bytes(no, Buffer.from(value ?? "", "utf8")),
}

const message = (...fields: Buffer[]): Buffer => Buffer.concat(fields)

/** A Connect envelope: flags, the length, then the message. */
function envelope(flags: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head[0] = flags
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

/* ----------------------------------------------------- what Devin sends */

/** One `exa.chat_pb.ChatMessagePrompt`, as far as telling requests apart and routing a step needs. */
interface Prompted {
  source: number
  prompt?: string
  tool_call_id?: string
  tool_calls?: { id?: string; name?: string; arguments_json?: string }[]
  thinking?: string
}

interface Conversation {
  system: string
  messages: Prompted[]
}

/**
 * A `GetChatMessageRequest`'s conversation: the system prompt (field 2) and
 * each `ChatMessagePrompt` (field 3: source 2, prompt 3, tool_calls 6,
 * tool_call_id 7, thinking 11), oldest first. Devin 3000.11.205 sends every
 * earlier turn, call and result in each request, the person's words with
 * source USER (1).
 */
function conversation(fields: readonly ProtoField[]): Conversation {
  const messages = fields.flatMap((field): Prompted[] => {
    if (field.no !== 3 || field.wire !== "bytes") return []
    const inner = protoFields(field.bytes)
    const source = inner.find((candidate) => candidate.no === 2)
    const calls = inner.flatMap((call) => {
      if (call.no !== 6 || call.wire !== "bytes") return []
      const parts = protoFields(call.bytes)
      return [{ id: text(parts, 1), name: text(parts, 2), arguments_json: text(parts, 3) }]
    })
    return [{
      source: source?.wire === "varint" ? source.value : 0,
      prompt: text(inner, 3),
      tool_call_id: text(inner, 7),
      ...calls.length && { tool_calls: calls },
      thinking: text(inner, 11),
    }]
  })
  return { system: text(fields, 2) ?? "", messages }
}

/** Devin 3000.11.205 names a session from its first message on a request of its own, with no tools. */
const TITLE_ASK = "You are a session title generator"
/** Its manual compaction asks for a summary of the conversation in a user message, which a script step answers. */
const COMPACTION_ASK = "Conversation to summarize:"

/* ---------------------------------------------------- what it gets back */

/** `exa.codeium_common_pb.StopReason`: a call ends a reply with FUNCTION_CALL, an answer with STOP_PATTERN. */
const STOP_PATTERN = 2
const FUNCTION_CALL = 10

/** What a scripted thinking block is signed with, opaque to Devin, which hands it back on the next request. */
const SIGNATURE = "scripted"

/**
 * A reply as `GetChatMessageResponse` messages: the ids, the reasoning in
 * `delta_thinking` (9) and then its signature (10, 21), the text in
 * `delta_text` (3), the call whole in `delta_tool_calls` (6), then the stop
 * reason (5) and usage (7: input 2, output 3), as the real server streams one.
 */
function replyMessages(reply: ScriptedReply): Buffer[] {
  const id = randomUUID()
  const messages = [message(write.text(1, id), write.text(17, randomUUID()))]
  for (const part of words(reply.reasoning)) messages.push(write.text(9, part))
  if (reply.reasoning) messages.push(message(write.text(10, SIGNATURE), write.text(21, SIGNATURE)))
  for (const part of words(reply.text)) messages.push(write.text(3, part))
  const call = reply.call
  if (call) {
    if ("input" in call) throw new Error(`Devin's tools take JSON arguments, not ${call.name}'s freeform input`)
    messages.push(write.bytes(6, message(write.text(1, call.id), write.text(2, call.name), write.text(3, JSON.stringify(call.arguments)))))
  }
  const usage = message(write.number(2, USAGE.input), write.number(3, USAGE.output))
  messages.push(message(write.text(1, id), write.number(5, call ? FUNCTION_CALL : STOP_PATTERN), write.bytes(7, usage)))
  return messages
}

/**
 * The one model the stand-in offers (`GetCliModelConfigs`'s
 * `client_model_configs`, each an `exa.codeium_common_pb.ClientModelConfig`:
 * label 1, supports_images 5, max_tokens 18, model_uid 22): the model Devin
 * 3000.11.205 picks when it is offered none, with the context window and
 * image support a catalog states, which Devin reports to its client.
 */
const SERVED = { uid: "swe-1-6-fast", label: "SWE-1.6 Fast", window: 256_000 }

function modelConfigs(): Buffer {
  return write.bytes(1, message(write.text(1, SERVED.label), write.number(5, 1), write.number(18, SERVED.window), write.text(22, SERVED.uid)))
}

/** The Connect code a scripted failure's HTTP status stands for. */
function connectCode(status: number): string {
  if (status === 429) return "resource_exhausted"
  if (status === 503) return "unavailable"
  if (status === 401) return "unauthenticated"
  return status >= 500 ? "internal" : "unknown"
}

/** The end of a Connect stream: `{}`, or the error the stream ended with. */
function endStream(fail?: ScriptedReply["fail"]): Buffer {
  return envelope(2, Buffer.from(JSON.stringify(fail ? { error: { code: connectCode(fail.status), message: fail.message } } : {}), "utf8"))
}

/**
 * A stand-in for Windsurf's API server that answers Devin's model requests
 * (`GetChatMessage`) from a script, its model catalog with the one model it
 * serves, and every other call it makes with an empty reply, which Devin
 * 3000.11.205 starts and runs on. A request whose
 * system prompt asks for a session title gets the aside; every other one,
 * the main conversation's, a subagent's and a compaction's, takes the
 * script's next step for what it carries (`heard`: its system prompt and
 * messages as JSON, so a prompt is found JSON-escaped, as `script()` looks
 * for it). Replies are never compressed: Devin 3000.10.23 refuses a
 * compressed one.
 */
export async function scriptedWindsurf(options: Pick<ScriptedModelOptions, "reply" | "aside"> & {
  /** A request that waits for other steps before it takes its own (`Script.waits`), held until it no longer does. */
  waits?: (heard: string) => boolean
}) {
  const requests: ScriptedRequest[] = []
  /** Requests held by `waits`, each checked again once any reply has been sent. */
  const held = new Set<() => void>()
  const recheck = () => {
    for (const check of held) check()
  }
  const free = (heard: string) => new Promise<void>((resolve) => {
    const check = () => {
      if (options.waits?.(heard)) return
      held.delete(check)
      resolve()
    }
    held.add(check)
    check()
  })
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", async () => {
      const path = request.url ?? "/"
      const method = path.split("/").pop()
      if (method !== "GetChatMessage") {
        response.writeHead(200, { "content-type": "application/proto" })
        return void response.end(method === "GetCliModelConfigs" ? modelConfigs() : undefined)
      }
      const body = connectMessage(Buffer.concat(chunks), requestEncoding(request.headers))
      const { system, messages } = conversation(protoFields(body))
      const titling = system.startsWith(TITLE_ASK)
      const compacting = messages.some((prompted) => prompted.prompt?.includes(COMPACTION_ASK))
      const scripted = !titling && (windsurfTools(body).length > 0 || compacting)
      const heard = JSON.stringify({ system, messages })
      if (scripted) await free(heard)
      const reply = scripted ? options.reply(heard) : { text: options.aside ?? "Notes" }
      requests.push({ path: `POST ${path}`, conversation: scripted, ...!reply && { unscripted: true } })
      response.writeHead(200, { "content-type": "application/connect+proto" })
      const answer = reply ?? { text: "The script has no more steps." }
      if (!answer.fail) for (const each of replyMessages(answer)) response.write(envelope(0, each))
      response.end(endStream(answer.fail), recheck)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port reports its address as an AddressInfo.
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
