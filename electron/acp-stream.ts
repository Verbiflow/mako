import type { Readable, Writable } from "node:stream"
import type { AnyMessage, SessionUpdate, Stream } from "@agentclientprotocol/sdk"
import { hostWarn } from "./host-log.js"
import type { JsonObject } from "./codex-app-json.js"

/**
 * Every `session/update` kind the SDK declares. A kind an SDK upgrade adds
 * fails to compile here until it is listed.
 */
const SESSION_UPDATE_KINDS = {
  user_message_chunk: true,
  agent_message_chunk: true,
  agent_thought_chunk: true,
  tool_call: true,
  tool_call_update: true,
  plan: true,
  plan_update: true,
  plan_removed: true,
  available_commands_update: true,
  current_mode_update: true,
  config_option_update: true,
  session_info_update: true,
  usage_update: true,
} satisfies Record<SessionUpdate["sessionUpdate"], true>

/** A `session/update` the SDK would refuse, which it drops after printing it whole to stderr. */
export interface RefusedSessionUpdate {
  params: JsonObject
  /** The update's `sessionUpdate`, or `(none)`. */
  kind: string
  /** A kind the SDK declares, sent in a shape its schema refuses. */
  known: boolean
}

/** A `session/update` the SDK accepted after dropping or replacing part of it. */
export interface LossySessionUpdate {
  kind: string
  /** Where the SDK lost a value, list indices as `[]`, e.g. `status` or `entries[]`. */
  paths: string[]
}

interface Parser {
  safeParse(value: unknown): { success: boolean; data?: unknown }
}

let notificationSchema: Promise<Parser | undefined> | undefined

/**
 * The SDK's own `session/update` schema, so the screen refuses exactly what
 * the SDK would. The package exports its types but not its schemas, so it is
 * found beside the SDK's entry point; if a release moves it, updates pass
 * through unscreened as before and the host log says so.
 */
export function acpSessionNotificationSchema(): Promise<Parser | undefined> {
  return notificationSchema ??= import(new URL("./schema/zod.gen.js", import.meta.resolve("@agentclientprotocol/sdk")).href)
    .then((module: { zSessionNotification?: Parser }) => {
      if (!module.zSessionNotification) throw new Error("zSessionNotification is not exported")
      return module.zSessionNotification
    })
    .catch((error: unknown) => {
      hostWarn("acp", "session updates are not screened", { error: error instanceof Error ? error.message : String(error) })
      return undefined
    })
}

/**
 * Takes the `session/update` notifications the SDK would refuse out of its
 * stream and hands them to `refused`, so an update Mako does not know
 * reaches its decoder or the unknown-event log instead of vanishing.
 * The SDK also accepts updates after quietly dropping what it doesn't know
 * inside them (an unknown tool status, a plan entry, an extra field); those
 * still pass, and `lossy` hears where.
 */
export async function screenSessionUpdates(
  stream: Stream,
  refused: (update: RefusedSessionUpdate) => void,
  lossy?: (update: LossySessionUpdate) => void,
): Promise<Stream> {
  const schema = await acpSessionNotificationSchema()
  if (!schema) return stream
  const readable = stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      if (!("method" in message) || "id" in message || message.method !== "session/update") {
        controller.enqueue(message)
        return
      }
      const params = isObject(message.params) ? message.params : {}
      const update = isObject(params["update"]) ? params["update"] : {}
      const kind = typeof update["sessionUpdate"] === "string" ? update["sessionUpdate"] : "(none)"
      const parsed = schema.safeParse(message.params)
      if (!parsed.success) {
        refused({ params, kind, known: Object.hasOwn(SESSION_UPDATE_KINDS, kind) })
        return
      }
      controller.enqueue(message)
      if (!lossy || !isObject(parsed.data)) return
      const paths = new Set<string>()
      lostValues(update, parsed.data["update"], "", paths)
      if (paths.size) lossy({ kind, paths: [...paths] })
    },
  }))
  return { readable, writable: stream.writable }
}

/** Distinct places a lossy update names; the rest of a huge update is not walked. */
const MAX_LOST_PATHS = 8

/** Where `parsed` lacks or replaced a value `raw` carried. Null carries nothing to lose. */
function lostValues(raw: unknown, parsed: unknown, path: string, paths: Set<string>): void {
  if (paths.size >= MAX_LOST_PATHS || raw === null || raw === undefined) return
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || parsed.length !== raw.length) {
      paths.add(`${path}[]`)
      return
    }
    raw.forEach((item, index) => lostValues(item, parsed[index], `${path}[]`, paths))
    return
  }
  if (isObject(raw)) {
    if (!isObject(parsed)) {
      paths.add(path || "(update)")
      return
    }
    for (const [key, value] of Object.entries(raw))
      lostValues(value, Object.hasOwn(parsed, key) ? parsed[key] : undefined, path ? `${path}.${key}` : key, paths)
    return
  }
  if (raw !== parsed) paths.add(path || "(update)")
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Node pipe bytes at the SDK's Web Streams boundary, with backpressure. */
export function acpReadable(pipe: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      pipe.on("data", (chunk: Buffer) => {
        controller.enqueue(chunk)
        if ((controller.desiredSize ?? 0) <= 0) pipe.pause()
      })
      pipe.once("end", () => controller.close())
      pipe.once("error", (error) => controller.error(error))
    },
    pull() {
      pipe.resume()
    },
    cancel() {
      pipe.destroy()
    },
  })
}

/**
 * A provider that exits or closes its stdin while a request is in flight
 * surfaces the failed write twice: in the write callback and as an `error`
 * event on the pipe. Without a listener the event is an uncaught exception in
 * the host process, so the pipe error is routed into the stream instead.
 */
export function acpWritable(pipe: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    start(controller) {
      pipe.once("error", (error) => controller.error(error))
    },
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        pipe.write(chunk, (error) => (error ? reject(error) : resolve()))
      })
    },
    close() {
      pipe.end()
    },
    abort() {
      pipe.destroy()
    },
  })
}
