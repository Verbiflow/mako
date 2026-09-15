import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"
import {
  diffLines,
  elementLines,
  lineAddress,
  shownValue,
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
const pageRoutesSchema = z.record(
  z.string(),
  z.looseObject({ browser: z.string() })
)
/** What an action's result says about its own delivery; the rest is the window's to show. */
const RESULT_KEYS = [
  "route",
  "delivery",
  "effect",
  "mako_routes",
  "escalation",
  "fronted",
  "carried_token",
]

export interface ViewOptions extends LineOptions {
  /** Elements to request from the driver; default 400. */
  max?: number
}
export interface ActOptions {
  /** Milliseconds to wait before the first re-read; default 400. */
  settle?: number
  /**
   * Milliseconds to keep re-reading while nothing has changed; default
   * 2500. A page transition in a WebKit shell took longer than one settle
   * and the empty delta cost the model a turn to look again.
   */
  wait?: number
  target?: Target
}
export interface UntilOptions {
  /** Milliseconds before giving up; default 5000. */
  timeout?: number
  /** Milliseconds between reads; default 250. */
  every?: number
  target?: Target
}
export interface FillOptions {
  /** Milliseconds to keep reading the control back; default 1500. */
  wait?: number
  target?: Target
}
export type Predicate = (lines: string[]) => boolean

const DEFAULT_MAX = 400
const DEFAULT_SETTLE_MS = 400
const DEFAULT_WAIT_MS = 2_500
const RECHECK_MS = 250
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_EVERY_MS = 250
const FILL_WAIT_MS = 1_500
const FILL_RECHECK_MS = 150
/**
 * How long a cached view stands in for the screen as a step's "before".
 * `state.last` outlives a program, and actions called by hand do not
 * refresh it, so a delta once reported what an earlier program changed.
 */
const BEFORE_MAX_AGE_MS = 1_500
const EXPECT_MAX_AGE_MS = 5_000

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface FillResult {
  action: "fill"
  route: "set_value"
  /** The control reads back the text. */
  confirmed: boolean
  /** The control's line after the write, when it was found. */
  line?: string
  result: JsonObject
}

export interface SubmitResult {
  action: "submit"
  /** The accessibility action that was accepted. */
  route: "confirm" | "press"
  result: JsonObject
}

export interface RouteVerdicts {
  target: Target
  /** Document windows of the pid, which decide whether pid keyboard is unambiguous. */
  documents: number
  onScreen: boolean | null
  accessibility: string
  pointer: string
  keyboard: string
  page: string
  command: string
  foreground: string
}

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
  fill(
    element_token: string,
    text: string,
    options?: FillOptions
  ): Promise<FillResult>
  submit(element_token: string): Promise<SubmitResult>
  routes(target?: Target): Promise<RouteVerdicts>
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
    const request: JsonObject = {
      pid: selected.pid,
      window_id: selected.window_id,
      include_screenshot: false,
      max_elements: max ?? DEFAULT_MAX,
    }
    if (options.query) request.query = options.query
    const result = await call("get_window_state", request)
    const parsed = windowStateSchema.safeParse(result)
    if (!parsed.success)
      throw new Error(
        "get_window_state returned no elements array; the window may be unresolved (see the driver's degraded_reason)."
      )
    const lines = elementLines(parsed.data.elements, lineOptions)
    state.last = lines
    state.lastAt = Date.now()
    return lines
  }
  const lastView = (maxAgeMs: number): string[] | undefined => {
    const cached = z.array(z.string()).safeParse(state.last)
    const at = z.number().safeParse(state.lastAt)
    if (!cached.success || !at.success || Date.now() - at.data > maxAgeMs)
      return undefined
    return cached.data
  }
  const resultOf = (raw: JsonValue): JsonObject => {
    const parsed = jsonObjectSchema.safeParse(raw)
    const result: JsonObject = {}
    if (parsed.success)
      for (const key of RESULT_KEYS)
        if (parsed.data[key] !== undefined) result[key] = parsed.data[key]
    return result
  }
  const addressOf = (element_token: string): string | undefined => {
    const line = lastView(Number.POSITIVE_INFINITY)?.find((entry) =>
      entry.startsWith(`${element_token} `)
    )
    return line ? lineAddress(line) : undefined
  }
  return {
    view,
    /**
     * The driver waits about a second after a key or click to verify it;
     * `act` reads the window while that wait runs, so a step costs the
     * longer of the two, not their sum. The action's own refusal still
     * rejects the step, at once: nothing is re-read for an action that
     * already failed.
     *
     * An action addressed by `element_token` is dispatched before anything
     * is read, whatever the age of the cached view: the driver honours
     * tokens from a window's newest snapshot only, so a read taken first
     * would make the model's own token stale. That is the view → decide →
     * act flow across two turns, and a turn is always older than the
     * freshness bound.
     */
    act: async (action, args = {}, options = {}) => {
      const selected = resolveTarget(options.target)
      const addressed = z.string().safeParse(args.element_token).success
      const before = addressed
        ? (lastView(Number.POSITIVE_INFINITY) ?? [])
        : (lastView(BEFORE_MAX_AGE_MS) ?? (await view(selected)))
      const pending = call(action, args)
      let settled = false
      let failed = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
          failed = true
        }
      )
      await wait(options.settle ?? DEFAULT_SETTLE_MS)
      if (failed) await pending
      const deadline = Date.now() + (options.wait ?? DEFAULT_WAIT_MS)
      let after = await view(selected)
      let delta = diffLines(before, after)
      while (
        !failed &&
        delta.added.length === 0 &&
        delta.removed.length === 0 &&
        (!settled || Date.now() < deadline)
      ) {
        await wait(RECHECK_MS)
        after = await view(selected)
        delta = diffLines(before, after)
      }
      const result = resultOf(await pending)
      return { action, result, ...delta }
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
      const lines = lastView(EXPECT_MAX_AGE_MS) ?? (await view())
      if (predicate(lines)) return
      throw new Error(
        `${message ?? "Expectation failed"}. The window shows:\n${lines.join("\n")}`
      )
    },
    windows: async (pid) => {
      const result = await call("list_windows", { pid })
      const parsed = windowListSchema.safeParse(result)
      if (!parsed.success) return []
      // The window an agent means comes first: a titled document that is on
      // screen, largest first. Conductor lists an untitled 500×500 window
      // that is off screen before its main window, and a caller that took
      // the first row viewed an empty window.
      const ranked: { record: JsonObject; rank: number; area: number }[] = []
      for (const raw of parsed.data.windows) {
        const window = WindowRecordSchema.safeParse(raw)
        if (!window.success) continue
        const kind = windowKind(window.data)
        if (kind === "helper") continue
        const record: JsonObject = {
          window_id: window.data.window_id,
          title: window.data.title ?? "",
          kind,
        }
        const { bounds, is_on_screen } = window.data
        if (bounds) record.bounds = bounds
        if (is_on_screen !== undefined && is_on_screen !== null)
          record.is_on_screen = is_on_screen
        ranked.push({
          record,
          rank: (kind === "document" ? 2 : 0) + (is_on_screen === true ? 1 : 0),
          area: bounds ? bounds.width * bounds.height : 0,
        })
      }
      return ranked
        .sort((left, right) => right.rank - left.rank || right.area - left.area)
        .map((row) => row.record)
    },
    /**
     * Text into a control without a keyboard: the accessibility value
     * write, then the control read back until it shows the text. Works on
     * a backgrounded Electron, Chromium or Cocoa field and never fronts.
     */
    fill: async (element_token, text, options = {}) => {
      const selected = resolveTarget(options.target)
      const address = addressOf(element_token)
      const result = resultOf(
        await call("set_value", { element_token, value: text })
      )
      const expected = shownValue(text)
      const deadline = Date.now() + (options.wait ?? FILL_WAIT_MS)
      let line: string | undefined
      for (;;) {
        const lines = await view(selected)
        line = address
          ? lines.find((entry) => lineAddress(entry) === address)
          : lines.find((entry) => entry.includes(expected))
        if (line?.includes(expected) || Date.now() >= deadline) break
        await wait(FILL_RECHECK_MS)
      }
      const confirmed = line?.includes(expected) ?? false
      return line
        ? { action: "fill", route: "set_value", confirmed, line, result }
        : { action: "fill", route: "set_value", confirmed, result }
    },
    /**
     * Enter without a keyboard: the control's confirm action, or its press
     * when it has no confirm. Background, no focus change.
     */
    submit: async (element_token) => {
      try {
        const result = resultOf(
          await call("click", { element_token, action: "confirm" })
        )
        return { action: "submit", route: "confirm", result }
      } catch {
        const result = resultOf(
          await call("click", { element_token, action: "press" })
        )
        return { action: "submit", route: "press", result }
      }
    },
    /**
     * The routes into a window, decided before a round trip is spent on a
     * refusal: the pid keyboard is ambiguous when the application has more
     * than one document window and refused when the window is off screen;
     * a page route exists only for an application Mako launched with one.
     */
    routes: async (target) => {
      const selected = resolveTarget(target)
      const list = windowListSchema.safeParse(
        await call("list_windows", { pid: selected.pid })
      )
      const records = list.success
        ? list.data.windows.flatMap((raw) => {
            const window = WindowRecordSchema.safeParse(raw)
            return window.success ? [window.data] : []
          })
        : []
      const documents = records.filter(
        (window) => windowKind(window) !== "helper"
      )
      const current = records.find(
        (window) => window.window_id === selected.window_id
      )
      const onScreen = current?.is_on_screen ?? null
      const pages = api.page_routes
        ? pageRoutesSchema.safeParse(await call("page_routes", {}))
        : undefined
      const page = pages?.success ? pages.data[String(selected.pid)] : undefined
      return {
        target: selected,
        documents: documents.length,
        onScreen,
        accessibility:
          "available: fill, set_value, click(element_token), submit; background and verifiable",
        pointer:
          onScreen === false
            ? "refused while the window is off screen or minimized"
            : "available: window-local x,y from the latest capture; background",
        keyboard:
          documents.length > 1
            ? `refused before dispatch: ${documents.length} document windows share this pid (same_pid_keyboard_ambiguity)`
            : onScreen === false
              ? "refused: the window is minimized or hidden"
              : "type_text and non-Cmd keys post in the background to a Cocoa field; a renderer drops them; Cmd chords are refused before dispatch",
        page: page
          ? `available: browser.<action>({browser: ${JSON.stringify(page.browser)}, ...})`
          : "none: launch_app({bundle_id, page_route: true}) gives an Electron or Chromium app one",
        command:
          "script({language, source}) and shell({command}) run without touching focus",
        foreground:
          "requires foreground: true on the call and the window already frontmost; bring_to_front and invoke_menu take the screen and require the flag",
      }
    },
  }
}
