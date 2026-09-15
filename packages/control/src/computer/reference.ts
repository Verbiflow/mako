import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"
import { normalizeDriverSchema } from "./driver-schema.js"

/**
 * The API reference a program is written against, rendered from the live
 * driver's tool catalog. It goes into the tool description so a model
 * writes its first program from the first turn; the two turns every model
 * spent on `status` then `help` before touching a window were 14 KB each
 * (docs/audits/2026-09-14, F8).
 */

const schemaObjectSchema = z.looseObject({
  properties: z.record(z.string(), z.json()).optional(),
  required: z.array(z.string()).optional(),
})

/** The shape of a driver tool this module reads; MCP's `Tool` satisfies it. */
export interface DriverTool {
  name: string
  description?: string
  inputSchema: JsonValue
  outputSchema?: JsonValue
}

const FOREGROUND_FLAG_SCHEMA: JsonObject = {
  type: "boolean",
  description:
    "Declare that this call may take the user's screen. Required for invoke_menu, bring_to_front and any delivery_mode:'foreground'; the result then reports fronted: {pid, ms}. Mako never fronts without it.",
}
const FORCE_FLAG_SCHEMA: JsonObject = {
  type: "boolean",
  description:
    "Post a background Cmd chord anyway. Without it Mako refuses the chord before dispatch, because an application that is not frontmost does not dispatch menu key equivalents.",
}

/** Driver actions that accept delivery_mode and so can be asked to front. */
export const DELIVERY_MODE_ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
  "browser_dialog",
] as const

/** Mako's own flags on driver actions, applied before the call reaches the driver. */
export const MAKO_ACTION_FLAGS = {
  invoke_menu: { foreground: FOREGROUND_FLAG_SCHEMA },
  bring_to_front: { foreground: FOREGROUND_FLAG_SCHEMA },
  click: { foreground: FOREGROUND_FLAG_SCHEMA },
  double_click: { foreground: FOREGROUND_FLAG_SCHEMA },
  right_click: { foreground: FOREGROUND_FLAG_SCHEMA },
  drag: { foreground: FOREGROUND_FLAG_SCHEMA },
  type_text: { foreground: FOREGROUND_FLAG_SCHEMA },
  scroll: { foreground: FOREGROUND_FLAG_SCHEMA },
  browser_dialog: { foreground: FOREGROUND_FLAG_SCHEMA },
  press_key: { foreground: FOREGROUND_FLAG_SCHEMA, force: FORCE_FLAG_SCHEMA },
  hotkey: { foreground: FOREGROUND_FLAG_SCHEMA, force: FORCE_FLAG_SCHEMA },
  launch_app: {
    page_route: {
      type: "boolean",
      description:
        "For an Electron or Chromium bundle: Mako launches it in the background with a private DevTools port and registers it with Mako's browser control as browser 'app:<bundle_id>', so browser.<action>({browser, ...}) drives its pages with background keyboard, pointer, DOM reads and screenshots. The result carries page_route: {browser, endpoint} or the reason none exists.",
    },
  },
  get_window_state: {
    include_markdown: {
      type: "boolean",
      description:
        "Include the driver's tree_markdown rendering of the same elements. Default false: the structured elements array carries every field, and the Markdown copy doubles the result size.",
    },
    include_menu_bar: {
      type: "boolean",
      description:
        "Keep the application's menu bar elements in the result. Default false: they are not in the window, and on a real app they were two thirds of the elements.",
    },
  },
} satisfies Readonly<Record<string, Readonly<Record<string, JsonObject>>>>

const flagTable = z.record(
  z.string(),
  z.record(z.string(), z.record(z.string(), z.json()))
)

function makoFlagsOf(action: string): Readonly<Record<string, JsonObject>> {
  return flagTable.parse(MAKO_ACTION_FLAGS)[action] ?? {}
}

/** Names of Mako's own flags on an action, to strip before the driver sees the call. */
export function makoFlagNames(action: string): string[] {
  return Object.keys(makoFlagsOf(action))
}

const SUMMARY_LENGTH = 140
const RETURN_KEYS = 8

export interface ProgramProperties {
  properties: Record<string, JsonValue>
  required: string[]
}

/** The properties a program passes: the driver's, less session, plus Mako's. */
export function programProperties(tool: DriverTool): ProgramProperties {
  const input = schemaObjectSchema.parse(tool.inputSchema)
  const properties = { ...input.properties, ...makoFlagsOf(tool.name) }
  delete properties.session
  return {
    properties: z
      .record(z.string(), z.json())
      .parse(normalizeDriverSchema(properties)),
    required: input.required?.filter((name) => name !== "session") ?? [],
  }
}

export function signatureOf(tool: DriverTool): string {
  const { properties, required } = programProperties(tool)
  const parameters = Object.keys(properties).map((name) =>
    required.includes(name) ? name : `${name}?`
  )
  return `computer.${tool.name}({${parameters.join(", ")}})`
}

/** The top-level keys of the action's structured result, when the driver declares them. */
export function returnsOf(tool: DriverTool): string | undefined {
  if (tool.outputSchema === undefined) return undefined
  const output = schemaObjectSchema.safeParse(tool.outputSchema)
  if (!output.success || !output.data.properties) return undefined
  const keys = Object.keys(output.data.properties)
  if (keys.length === 0) return undefined
  const shown = keys.slice(0, RETURN_KEYS)
  return `{${shown.join(", ")}${keys.length > shown.length ? ", …" : ""}}`
}

export function summaryOf(tool: DriverTool): string {
  const sentence = (tool.description ?? "").split(/(?<=\.)\s/)[0] ?? ""
  return sentence.length > SUMMARY_LENGTH
    ? `${sentence.slice(0, SUMMARY_LENGTH - 1)}…`
    : sentence
}

/** One reference line per action: signature, return shape, first sentence. */
export function actionLine(tool: DriverTool): string {
  const returns = returnsOf(tool)
  const summary = summaryOf(tool)
  return `${signatureOf(tool)}${returns ? ` → ${returns}` : ""}${summary ? `  ${summary}` : ""}`
}

/**
 * Mako's own actions on the computer object, beside the driver's. They
 * are rendered into the reference like driver actions and dispatched by
 * the server, never by the driver: a command route (the old macOS harness
 * had it) that a program chooses in the same branch as a GUI route.
 */
export const MAKO_ACTIONS: readonly DriverTool[] = [
  {
    name: "script",
    description:
      "Run an AppleScript or JavaScript for Automation source through osascript, detached from the desk's focus. Finder, System Events and any application with a scripting dictionary; a Finder listing is one line here and eleven windows of accessibility on the GUI route. Output past the inline budget spills to a file like every other result.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["applescript", "jxa"],
          description:
            "applescript (default) or jxa (JavaScript for Automation).",
        },
        source: { type: "string", description: "The script source." },
        timeout_ms: {
          type: "integer",
          minimum: 100,
          maximum: 55000,
          description: "Default 20000.",
        },
      },
      required: ["source"],
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exit_code: { type: "integer" },
        ms: { type: "integer" },
      },
    },
  },
  {
    name: "shell",
    description:
      "Run one shell command (/bin/sh -c) with a cwd and a timeout and return its output. For a file, process or system fact that has a command; not a way around a refused GUI route.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line for /bin/sh -c.",
        },
        cwd: {
          type: "string",
          description: "Working directory; default the server's.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 100,
          maximum: 55000,
          description: "Default 20000.",
        },
      },
      required: ["command"],
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exit_code: { type: "integer" },
        ms: { type: "integer" },
      },
    },
  },
  {
    name: "page_routes",
    description:
      "The page routes this task has: by pid, the browser id and endpoint of every Electron or Chromium application Mako launched with page_route: true. routes(target) reads it for you.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
  },
]

/** The helpers every computer program has, in the words the description uses. */
export const HELPER_REFERENCE = [
  'view(target?, {query?, interactive?, frames?, max?}) → string[]  One line per accessible element of the window: <element_token> Role "label" =value, menu bar excluded, ~13 tokens a line. target is {pid, window_id}; defaults to state.target and sets it. Cached in state.last. Every read (view, act, until, get_window_state) is a new snapshot and supersedes earlier tokens: address the next action with a token from the latest lines.',
  "act(action, args, {settle?, wait?, target?}) → {action, result, added: string[], removed: string[], unchanged: number}  One driver action (by name, same args as computer.<action>), then the lines that appeared and disappeared in the window: read after settle ms (default 400) and re-read every 250 ms while nothing has changed, up to wait ms (default 2500). A click and what it revealed are one call; the new tokens are in added. A token from an earlier program is fine: an action with element_token is dispatched before anything is read, so the token is never made stale by act itself.",
  "until(predicate, {timeout?, every?, target?}) → {satisfied, ms, view}  Re-read the window every 250 ms until predicate(lines) is true or timeout ms (default 5000) pass.",
  "expect(predicate, message?)  Check an assumption against the current view; when it fails the program stops and the error carries the view, so a chained step never runs on a screen you did not expect.",
  "windows(pid) → [{window_id, title, kind, bounds, is_on_screen}]  The application's windows with kind document | helper | unknown, the on-screen titled documents first (largest first); helper strips are omitted. The first row is the window you most likely mean.",
  "fill(element_token, text, {wait?, target?}) → {action, route, confirmed, line, result}  Text into a control without a keyboard: set_value, then the control read back until its line shows the text (confirmed) or wait ms (default 1500) pass. Works on a backgrounded Electron, Chromium or Cocoa field; never fronts.",
  "submit(element_token) → {action, route: confirm | press, result}  Enter without a keyboard: the control's confirm action, or its press when it has none. Background.",
  "routes(target?) → {documents, onScreen, accessibility, pointer, keyboard, page, command, foreground}  Which routes reach this window, decided before a round trip: pid keyboard is refused when the app has several document windows or the window is off screen; page names the browser id when the app has a page route.",
] as const

/** The whole reference: helpers, then every driver action. */
export function renderReference(tools: readonly DriverTool[]): string {
  const actions = tools.map((tool) => `  ${actionLine(tool)}`)
  return [
    "Helpers (async, available in every program):",
    ...HELPER_REFERENCE.map((line) => `  ${line}`),
    "",
    "Mako actions (computer.<action>(args), run by Mako, not the driver):",
    ...MAKO_ACTIONS.map((tool) => `  ${actionLine(tool)}`),
    "",
    tools.length
      ? "Driver actions (computer.<action>(args) resolves to the driver's data; a refused action throws with the driver's message; never pass session; foreground: true declares a call that takes the screen and is required by invoke_menu, bring_to_front and delivery_mode:'foreground'):"
      : "Driver actions: none — the native driver is not attached to this host.",
    ...actions,
  ].join("\n")
}
