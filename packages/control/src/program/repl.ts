import { parse } from "acorn"
import type { Runtime } from "node:inspector"
import { Session } from "node:inspector/promises"
import { constants, createContext, type Context } from "node:vm"
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

/** A program that failed to compile never ran, so nothing was dispatched. */
export function syntaxError(where: string): ControlFault {
  return new ControlFault(
    "syntax-error",
    `The program did not run: ${where}. Nothing was dispatched; fix the source and run it again.`,
    "not-dispatched"
  )
}

type SyntaxNode = { type: string; start: number; kind?: string }
const functionNodes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
])
function returnsAtTopLevel(node: SyntaxNode): boolean {
  if (node.type === "ReturnStatement") return true
  if (functionNodes.has(node.type)) return false
  return Object.values(node).some((child: unknown) =>
    (Array.isArray(child) ? child : [child]).some(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        returnsAtTopLevel(item as SyntaxNode)
    )
  )
}

/**
 * V8's REPL mode redeclares a name only with the same keyword, so `let x` after
 * an earlier cell's `const x` would not compile: top-level const becomes let.
 * A top-level return (the CLI's program style) makes the cell an async function
 * body whose value is the returned one; its bindings stay local to that cell.
 * Source the parser rejects is left for V8 to report.
 */
export function replSource(source: string): string {
  let program: { body: SyntaxNode[] }
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as { body: SyntaxNode[] }
  } catch {
    return source
  }
  if (program.body.some(returnsAtTopLevel))
    return `await (async () => {\n${source}\n})()`
  let rewritten = source
  for (const node of [...program.body].reverse())
    if (node.type === "VariableDeclaration" && node.kind === "const")
      rewritten = `${rewritten.slice(0, node.start)}let${rewritten.slice(node.start + "const".length)}`
  return rewritten
}

/** V8 owns REPL syntax, lexical bindings and top-level await. Source changes are
 * limited to replSource. No inspector listener or network port. This is trusted
 * code, not an OS sandbox. */
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
        this.context = createContext(
          {
            ...globals,
            process,
            fetch,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            AbortController,
            AbortSignal,
            structuredClone,
            performance,
            setInterval,
            clearInterval,
            setImmediate,
            clearImmediate,
            queueMicrotask,
          },
          {
            name: "mako-control",
            // Node's own loader preserves import() for trusted scripts. The worker
            // is still the cancellation boundary; vm is not a security boundary.
            importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
          }
        )
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
          expression: replSource(source),
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
        // A cell that failed to compile has no stack frame of its own; one
        // that threw a SyntaxError while running (JSON.parse, eval) has.
        const details = evaluated.exceptionDetails
        // A declaration conflict fails while the cell's bindings are created,
        // before its first statement, though V8 reports a frame for it.
        const conflict = /has already been declared/.test(message)
        if (
          exception?.className === "SyntaxError" &&
          (conflict ||
            !details.stackTrace?.callFrames.some(
              (frame) => frame.scriptId === details.scriptId
            ))
        )
          throw syntaxError(
            `${message} (line ${details.lineNumber + 1})${conflict ? ". An earlier cell declared it with var, function or class; assign to it instead, or use another name" : ""}`
          )
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
