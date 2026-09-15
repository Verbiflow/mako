import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parentPort } from "node:worker_threads"
import { z } from "zod"
import type { JsonValue } from "../json.js"
import { artifactFileName } from "./artifacts.js"
import {
  computerHelpers,
  type ComputerHelpers,
} from "../computer/steps.js"

const identifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
const incoming = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    source: z.string(),
    runId: z.number(),
    namespace: identifier,
    actions: z.array(identifier).max(128),
    artifacts: z.string().min(1),
  }),
  z.object({
    kind: z.literal("reply"),
    id: z.number(),
    value: z.json().optional(),
    error: z.string().optional(),
  }),
])
const imageValue = z.object({
  data: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
})

const port = parentPort
if (!port) throw new Error("Control programs run in a worker")

const pending = new Map<
  number,
  { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
>()
const state: Record<string, JsonValue> = {}
let sequence = 0

/**
 * What a program returns is JSON: an object with an `undefined` member
 * (`{delivery: result.structuredContent?.delivery}` when the driver sent
 * none) once crossed the port intact and failed the host's schema as
 * "invalid message", losing the run. A JSON round trip drops those the way
 * the tool result would anyway; a value JSON cannot carry is named.
 */
function jsonSafe(value: JsonValue | undefined): JsonValue {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new Error(
      `Program output is not JSON (${error instanceof Error ? error.message : String(error)}). Return plain objects, arrays, strings, numbers, booleans or null.`,
      { cause: error }
    )
  }
  return text === undefined ? null : z.json().parse(JSON.parse(text))
}

/** Programs write what they choose to keep: JSON, or an image block. */
function saveArtifact(directory: string, name: string, value: JsonValue) {
  mkdirSync(directory, { recursive: true })
  const image = imageValue.safeParse(value)
  const body = image.success
    ? Buffer.from(image.data.data, "base64")
    : Buffer.from(JSON.stringify(value))
  const path = join(
    directory,
    artifactFileName(
      name,
      image.success
        ? image.data.mimeType === "image/png"
          ? "png"
          : "jpg"
        : "json"
    )
  )
  writeFileSync(path, body)
  return { path, bytes: body.byteLength }
}

port.on("message", (raw) => {
  const message = incoming.parse(raw)
  if (message.kind === "reply") {
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) request?.reject(new Error(message.error))
    else request?.resolve(message.value ?? null)
    return
  }

  const runId = message.runId
  let active = true
  const requests = new Set<number>()
  const api = Object.fromEntries(
    message.actions.map((action) => [
      action,
      (args: Record<string, JsonValue> = {}) => {
        if (!active)
          throw new Error(
            "This script has already finished; late control actions are refused"
          )
        return new Promise<JsonValue>((resolve, reject) => {
          const id = ++sequence
          requests.add(id)
          pending.set(id, {
            resolve: (value) => {
              requests.delete(id)
              resolve(value)
            },
            reject: (error) => {
              requests.delete(id)
              reject(error)
            },
          })
          port.postMessage({
            kind: "call",
            runId,
            id,
            command: { ...args, action },
          })
        })
      },
    ])
  )
  const output = (kind: "output" | "image", value: JsonValue) => {
    if (active) port.postMessage({ kind, runId, value: jsonSafe(value) })
  }
  const artifacts = {
    save: (name: string, value: JsonValue) =>
      saveArtifact(message.artifacts, z.string().min(1).parse(name), value),
  }

  // Step helpers are the namespace's, built over the same actions the
  // program calls by hand; they hold no authority a program lacks.
  const helpers: Partial<ComputerHelpers> =
    message.namespace === "computer" ? computerHelpers(api, state) : {}

  // Trusted local JavaScript. Worker isolation bounds scheduling, not OS authority.
  void Promise.resolve()
    .then(() => {
      const run = new Function(
        message.namespace,
        "state",
        "console",
        "emitImage",
        "artifacts",
        ...Object.keys(helpers),
        `return (async () => {${message.source}\n})()`
      )
      return run(
        api,
        state,
        {
          log: (...values: JsonValue[]) =>
            output("output", values.length === 1 ? values[0] : values),
        },
        (value: JsonValue) => output("image", value),
        artifacts,
        ...Object.values(helpers)
      )
    })
    .then((value: JsonValue | undefined) => {
      if (requests.size)
        throw new Error(
          "Script returned with unawaited control actions. Their outcome may be unknown; observe before retrying."
        )
      return jsonSafe(value)
    })
    .then(
      (value) => {
        active = false
        port.postMessage({ kind: "done", runId, value })
      },
      (error) => {
        active = false
        port.postMessage({
          kind: "error",
          runId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    )
})
