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

/** Mako's own flags on driver actions, applied before the call reaches the driver. */
export const MAKO_ACTION_FLAGS: Readonly<Record<string, Readonly<Record<string, JsonObject>>>> = {
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
}

const SUMMARY_LENGTH = 140
const RETURN_KEYS = 8

/** The properties a program passes: the driver's, less session, plus Mako's. */
export function programProperties(tool: DriverTool): {
  properties: Record<string, JsonValue>
  required: string[]
} {
  const input = schemaObjectSchema.parse(tool.inputSchema)
  const properties: Record<string, JsonValue> = { ...input.properties }
  delete properties.session
  for (const [name, flag] of Object.entries(MAKO_ACTION_FLAGS[tool.name] ?? {}))
    properties[name] = flag
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

/** The helpers every computer program has, in the words the description uses. */
export const HELPER_REFERENCE = [
  'view(target?, {query?, interactive?, frames?, max?}) → string[]  One line per accessible element of the window: <element_token> Role "label" =value, menu bar excluded, ~13 tokens a line. target is {pid, window_id}; defaults to state.target and sets it. Cached in state.last.',
  "act(action, args, {settle?, target?}) → {action, result, added, removed, unchanged}  One driver action (by name, same args as computer.<action>), then after settle ms (default 600) the lines that appeared and disappeared in the window. A click and what it revealed are one call.",
  "until(predicate, {timeout?, every?, target?}) → {satisfied, ms, view}  Re-read the window every 250 ms until predicate(lines) is true or timeout ms (default 5000) pass.",
  "expect(predicate, message?)  Check an assumption against the current view; when it fails the program stops and the error carries the view, so a chained step never runs on a screen you did not expect.",
  "windows(pid) → [{window_id, title, kind, bounds, is_on_screen}]  The application's windows with kind document | helper | unknown; helper strips are omitted.",
] as const

/** The whole reference: helpers, then every driver action. */
export function renderReference(tools: readonly DriverTool[]): string {
  const actions = tools.map((tool) => `  ${actionLine(tool)}`)
  return [
    "Helpers (async, available in every program):",
    ...HELPER_REFERENCE.map((line) => `  ${line}`),
    "",
    tools.length
      ? "Driver actions (computer.<action>(args) resolves to the driver's data; a refused action throws with the driver's message; never pass session):"
      : "Driver actions: none — the native driver is not attached to this host.",
    ...actions,
  ].join("\n")
}
