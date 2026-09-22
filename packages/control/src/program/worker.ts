import {
  ControlFault,
  ControlFaultSchema,
  controlFaultData,
} from "../control/fault.js"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parentPort } from "node:worker_threads"
import { z } from "zod"
import type { JsonValue } from "../json.js"
import { AsyncLocalStorage } from "node:async_hooks"
import { controlClient } from "../control/client.js"
import { artifactFileName } from "./artifacts.js"
import { computerHelpers, type ComputerHelpers } from "../computer/steps.js"
import { checkpointTask, recallTask } from "./task-state.js"

const identifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
const incoming = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    source: z.string(),
    runId: z.number(),
    namespace: identifier,
    actions: z.array(identifier).max(128),
    extra: z.record(identifier, z.array(identifier).max(128)).default({}),
    artifacts: z.string().min(1),
  }),
  z.object({
    kind: z.literal("reply"),
    id: z.number(),
    value: z.json().optional(),
    error: z.string().optional(),
    fault: ControlFaultSchema.optional(),
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

interface RunContext {
  runId: number
  active: boolean
  requests: Set<number>
}
const runs = new AsyncLocalStorage<RunContext>()
const call = (
  namespace: string,
  action: string,
  args: Record<string, JsonValue> = {}
) => {
  const context = runs.getStore()
  if (!context?.active)
    throw new Error(
      "This script has already finished; late control actions are refused"
    )
  return new Promise<JsonValue>((resolve, reject) => {
    const id = ++sequence
    context.requests.add(id)
    pending.set(id, {
      resolve: (value) => {
        context.requests.delete(id)
        resolve(value)
      },
      reject: (error) => {
        context.requests.delete(id)
        reject(error)
      },
    })
    port.postMessage({
      kind: "call",
      runId: context.runId,
      id,
      namespace,
      command: { ...args, action },
    })
  })
}
const client = controlClient((action, args) => call("control", action, args))

port.on("message", (raw) => {
  const message = incoming.parse(raw)
  if (message.kind === "reply") {
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error)
      request?.reject(
        message.fault
          ? new ControlFault(
              message.fault.code,
              message.error,
              message.fault.outcome
            )
          : new Error(message.error)
      )
    else request?.resolve(message.value ?? null)
    return
  }

  const runId = message.runId
  const context: RunContext = { runId, active: true, requests: new Set() }
  const apiFor = (namespace: string, actions: readonly string[]) =>
    Object.fromEntries(
      actions.map((action) => [
        action,
        (args: Record<string, JsonValue> = {}) => call(namespace, action, args),
      ])
    )
  const api = apiFor(message.namespace, message.actions)
  const controlApi = message.namespace === "control" ? client : api
  const extras = Object.entries(message.extra).filter(
    ([name]) => name !== message.namespace
  )
  const output = (kind: "output" | "image", value: JsonValue) => {
    if (context.active)
      port.postMessage({ kind, runId, value: jsonSafe(value) })
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
  void runs.run(context, () =>
    Promise.resolve()
      .then(() => {
        const run = new Function(
          message.namespace,
          ...extras.map(([name]) => name),
          "state",
          "console",
          "emitImage",
          "artifacts",
          "checkpoint",
          "recall",
          ...Object.keys(helpers),
          `return (async () => {${message.source}\n})()`
        )
        return run(
          controlApi,
          ...extras.map(([name, actions]) => apiFor(name, actions)),
          state,
          {
            log: (...values: JsonValue[]) =>
              output("output", values.length === 1 ? values[0] : values),
          },
          (value: JsonValue) => output("image", value),
          artifacts,
          (value: Record<string, JsonValue>) =>
            checkpointTask(state, z.record(z.string(), z.json()).parse(value)),
          () => recallTask(state),
          ...Object.values(helpers)
        )
      })
      .then((value: JsonValue | undefined) => {
        if (context.requests.size)
          throw new Error(
            "Script returned with unawaited control actions. Their outcome may be unknown; observe before retrying."
          )
        return jsonSafe(value)
      })
      .then(
        (value) => {
          context.active = false
          port.postMessage({ kind: "done", runId, value })
        },
        (error) => {
          context.active = false
          port.postMessage({
            kind: "error",
            runId,
            message: error instanceof Error ? error.message : String(error),
            fault: controlFaultData(error),
          })
        }
      )
  )
})
