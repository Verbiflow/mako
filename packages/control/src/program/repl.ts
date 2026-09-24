import type { Runtime } from "node:inspector"
import { Session } from "node:inspector/promises"
import { createContext, type Context } from "node:vm"
import { z } from "zod"
import { ControlFault, controlFaultData } from "../control/fault.js"
import type { controlClient } from "../control/client.js"
import type { checkpointTask, recallTask } from "./task-state.js"
import type { JsonValue } from "../json.js"

interface ReplBindings {
  control: ReturnType<typeof controlClient> & {
    rewriteDocumentation(): Promise<void>
  }
  state: Record<string, JsonValue>
  console: { log(...values: JsonValue[]): void }
  emitImage(value: JsonValue): void
  artifacts: {
    save(name: string, value: JsonValue): { path: string; bytes: number }
  }
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  Buffer: typeof Buffer
  checkpoint(
    value: Record<string, JsonValue>
  ): ReturnType<typeof checkpointTask>
  recall(): ReturnType<typeof recallTask>
}

/** V8 owns REPL syntax, lexical bindings and top-level await. No source rewriting,
 * inspector listener or network port. This is trusted code, not an OS sandbox. */
export class ControlRepl {
  private readonly inspector = new Session()
  private readonly ready: Promise<number>
  private sequence = 0
  private context?: Context

  constructor(globals: ReplBindings) {
    this.inspector.connect()
    this.ready = (async () => {
      let contextId: number | undefined
      const created = ({
        params,
      }: {
        params: { context: { name: string; id: number } }
      }) => {
        if (params.context.name === "mako-control")
          contextId = params.context.id
      }
      this.inspector.on("Runtime.executionContextCreated", created)
      try {
        await this.inspector.post("Runtime.enable")
        this.context = createContext(globals, { name: "mako-control" })
        if (contextId === undefined)
          throw new Error("Control REPL context was not created")
        return contextId
      } finally {
        this.inspector.off("Runtime.executionContextCreated", created)
      }
    })()
  }

  async evaluate(source: string): Promise<JsonValue> {
    const contextId = await this.ready
    if (!this.context) throw new Error("Control REPL context was lost")
    const objectGroup = `mako-cell-${++this.sequence}`
    try {
      const evaluation: Runtime.EvaluateParameterType & { replMode: boolean } =
        {
          expression: source,
          contextId,
          replMode: true,
          awaitPromise: true,
          objectGroup,
        }
      const evaluated = await this.inspector.post(
        "Runtime.evaluate",
        evaluation
      )
      if (evaluated.exceptionDetails) {
        const exception = evaluated.exceptionDetails.exception
        const detail = exception?.objectId
          ? (
              await this.inspector.post("Runtime.callFunctionOn", {
                objectId: exception.objectId,
                functionDeclaration:
                  "function() { return {message: String(this.message ?? this), code: this.code, outcome: this.outcome}; }",
                returnByValue: true,
                objectGroup,
              })
            ).result.value
          : {
              message: String(
                exception?.value ?? evaluated.exceptionDetails.text
              ),
            }
        const parsed = z.object({ message: z.string() }).safeParse(detail)
        const message = parsed.success
          ? parsed.data.message
          : "Control REPL evaluation failed"
        const fault = controlFaultData(detail)
        throw fault
          ? new ControlFault(fault.code, message, fault.outcome)
          : new Error(message)
      }
      const result = evaluated.result
      if (result.type === "undefined") return null
      if (result.objectId) {
        // Honour the SDK's compact toJSON views instead of serializing private
        // handle fields or duplicating the full accessibility tree.
        const serialized = await this.inspector.post("Runtime.callFunctionOn", {
          objectId: result.objectId,
          functionDeclaration: "function() { return JSON.stringify(this); }",
          returnByValue: true,
          objectGroup,
        })
        if (serialized.exceptionDetails)
          throw new Error(
            "Program output is not JSON. Print a compact value with console.log instead."
          )
        return serialized.result.value === undefined
          ? null
          : z
              .json()
              .parse(JSON.parse(z.string().parse(serialized.result.value)))
      }
      if (result.unserializableValue)
        throw new Error(
          `Program output is not JSON (${result.unserializableValue}). Print a string instead.`
        )
      return z.json().parse(result.value ?? null)
    } finally {
      await this.inspector.post("Runtime.releaseObjectGroup", { objectGroup })
    }
  }
}
