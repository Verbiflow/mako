import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"
import {
  diffLines,
  elementLines,
  windowKind,
  WindowRecordSchema,
  type LineOptions,
  type ViewDelta,
} from "./projection.js"

/**
 * The step primitives a computer program composes with. They run inside
 * the program worker over the same `computer.<action>` calls a program
 * makes by hand, so nothing here has authority the program lacks; they
 * exist because a click and what it revealed should be one call and one
 * turn, and a program that runs ahead should stop the moment the screen
 * is not what it assumed (docs/audits/2026-09-14, F13).
 */

export type Action = (args?: JsonObject) => Promise<JsonValue>
export type Actions = Readonly<Record<string, Action>>

const targetSchema = z.object({
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
})
export type Target = z.infer<typeof targetSchema>

const windowStateSchema = z.looseObject({ elements: z.array(z.json()) })
const windowListSchema = z.looseObject({ windows: z.array(z.json()) })
const jsonObjectSchema = z.record(z.string(), z.json())
/** What an action's result says about its own delivery; the rest is the window's to show. */
const RESULT_KEYS = ["route", "delivery", "effect", "mako_routes", "escalation"]

export interface ViewOptions extends LineOptions {
  /** Elements to request from the driver; default 400. */
  max?: number
}
export interface ActOptions {
  /** Milliseconds to wait before re-reading the window; default 600. */
  settle?: number
  target?: Target
}
export interface UntilOptions {
  /** Milliseconds before giving up; default 5000. */
  timeout?: number
  /** Milliseconds between reads; default 250. */
  every?: number
  target?: Target
}
export type Predicate = (lines: string[]) => boolean

const DEFAULT_MAX = 400
const DEFAULT_SETTLE_MS = 600
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_EVERY_MS = 250

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface ComputerHelpers {
  view(target?: Target, options?: ViewOptions): Promise<string[]>
  act(
    action: string,
    args?: JsonObject,
    options?: ActOptions
  ): Promise<ViewDelta & { action: string; result: JsonObject }>
  until(
    predicate: Predicate,
    options?: UntilOptions
  ): Promise<{ satisfied: boolean; ms: number; view: string[] }>
  expect(predicate: Predicate, message?: string): Promise<void>
  windows(pid: number): Promise<JsonObject[]>
}

export function computerHelpers(
  api: Actions,
  state: Record<string, JsonValue>
): ComputerHelpers {
  const call = (name: string, args: JsonObject): Promise<JsonValue> => {
    const action = api[name]
    if (!action)
      throw new Error(
        `Unknown computer action "${name}". The reference in the tool description lists every action.`
      )
    return action(args)
  }
  const resolveTarget = (target?: Target): Target => {
    if (target) {
      const parsed = targetSchema.parse(target)
      state.target = parsed
      return parsed
    }
    const remembered = targetSchema.safeParse(state.target)
    if (!remembered.success)
      throw new Error(
        "No window is selected: pass {pid, window_id} or set state.target first (windows(pid) lists an application's document windows)."
      )
    return remembered.data
  }
  const view: ComputerHelpers["view"] = async (target, options = {}) => {
    const selected = resolveTarget(target)
    const { max, ...lineOptions } = options
    const result = await call("get_window_state", {
      pid: selected.pid,
      window_id: selected.window_id,
      include_screenshot: false,
      max_elements: max ?? DEFAULT_MAX,
      ...(options.query ? { query: options.query } : {}),
    })
    const parsed = windowStateSchema.safeParse(result)
    if (!parsed.success)
      throw new Error(
        "get_window_state returned no elements array; the window may be unresolved (see the driver's degraded_reason)."
      )
    const lines = elementLines(parsed.data.elements, lineOptions)
    state.last = lines
    return lines
  }
  const lastView = (): string[] | undefined => {
    const cached = z.array(z.string()).safeParse(state.last)
    return cached.success ? cached.data : undefined
  }
  return {
    view,
    act: async (action, args = {}, options = {}) => {
      const selected = resolveTarget(options.target)
      const before = lastView() ?? (await view(selected))
      const raw = jsonObjectSchema.safeParse(await call(action, args))
      const result: JsonObject = {}
      if (raw.success)
        for (const key of RESULT_KEYS)
          if (raw.data[key] !== undefined) result[key] = raw.data[key]
      await wait(options.settle ?? DEFAULT_SETTLE_MS)
      const after = await view(selected)
      return { action, result, ...diffLines(before, after) }
    },
    until: async (predicate, options = {}) => {
      const selected = resolveTarget(options.target)
      const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
      const every = options.every ?? DEFAULT_EVERY_MS
      const started = Date.now()
      let lines = await view(selected)
      while (!predicate(lines)) {
        if (Date.now() - started >= timeout)
          return { satisfied: false, ms: Date.now() - started, view: lines }
        await wait(every)
        lines = await view(selected)
      }
      return { satisfied: true, ms: Date.now() - started, view: lines }
    },
    expect: async (predicate, message) => {
      const lines = lastView() ?? (await view())
      if (predicate(lines)) return
      throw new Error(
        `${message ?? "Expectation failed"}. The window shows:\n${lines.join("\n")}`
      )
    },
    windows: async (pid) => {
      const result = await call("list_windows", { pid })
      const parsed = windowListSchema.safeParse(result)
      if (!parsed.success) return []
      const windows: JsonObject[] = []
      for (const raw of parsed.data.windows) {
        const window = WindowRecordSchema.safeParse(raw)
        if (!window.success) continue
        const kind = windowKind(window.data)
        if (kind === "helper") continue
        windows.push({
          window_id: window.data.window_id,
          title: window.data.title ?? "",
          kind,
          ...(window.data.bounds ? { bounds: window.data.bounds } : {}),
          ...(window.data.is_on_screen !== undefined &&
          window.data.is_on_screen !== null
            ? { is_on_screen: window.data.is_on_screen }
            : {}),
        })
      }
      return windows
    },
  }
}
