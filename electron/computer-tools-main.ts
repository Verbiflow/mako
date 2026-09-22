import type { JsonValue } from "./codex-app-json.js"
import { AppshotTargetSchema } from "./contracts/appshots.js"
import { verifyForegroundInput } from "./computer-input-target.js"
import { ComputerObservationClient } from "./computer-observation-client.js"
import { resolveDriverPaths } from "./computer-paths.js"
import {
  ControlProgramRequestSchema,
  ControlProgramInputSchema,
  ControlProgramRuntime,
  INLINE_IMAGE_COUNT,
  INLINE_TEXT_BUDGET,
  PROGRAM_TIME_LIMIT_MS,
  controlArtifactsDirectory,
  type ControlProgramOutput,
} from "@mako/control/program"
import {
  actionReceipt,
  ElementSchema,
  BACKGROUND_INPUT_LADDER,
  elementLines,
  KEYBOARD_TOOLS,
  KEY_ROUTE_ADVICE,
  MAKO_ACTIONS,
  deliveredForeground,
  indexSnapshot,
  keyRouteAdvice,
  makoFlagNames,
  normalizeDriverSchema,
  programProperties,
  refusalFor,
  renderReference,
  signatureOf,
  summaryOf,
  toolResultData,
  toolResultError,
  withWindowKinds,
  windowCapabilities,
  withoutEscalationNudge,
  withoutMenuBar,
  type DriverTool,
  type SnapshotIndex,
} from "@mako/control/computer"
import {
  scopeControlNodes,
  ControlDispatchRequestSchema,
  ControlRawRequestSchema,
  ControlEventsRequestSchema,
  ControlObserveRequestSchema,
  ControlTargetSchema,
  ControlFault,
  controlFaultData,
  ControlTargetsRequestSchema,
  controlLineRef,
  ControlObservationSchema,
  pageElementLines,
  planControlOperation,
  type ControlTarget,
  type PageTarget,
  type WindowControlTarget,
} from "@mako/control/control"
import { BROWSER_ACTIONS, type BrowserCall } from "./browser-tools-runtime.js"
import { browserProtocolHelp } from "./browser-protocol-help.js"
import { browserControlClient } from "./browser-control-client.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
} from "./contracts/browser-control.js"
import {
  connectMcpComputerDriver,
  type ComputerDriverClient,
  type ComputerDriverConnector,
  type ComputerDriverProcess,
} from "./computer-driver-client.js"
import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { createServer } from "node:net"
import { basename } from "node:path"
import {
  ControlImageSchema,
  type ControlImage,
} from "./contracts/control-preview.js"
import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { parseArgs } from "node:util"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { isMainModule } from "./main-module.js"

export { BACKGROUND_INPUT_LADDER }

const DEFAULT_MAX_ELEMENTS = 300

const instructions = `Mako computer control is one program tool over a host-owned native driver. mako_computer_exec runs trusted async JavaScript in a local worker; its description carries the whole API, so write the first program from it. Await every call and return only what you need to decide the next step.

How to work: windows(pid) to pick the document window; view(target) to read it as one line per element; act('click', {element_token}, {postcondition: lines => lines.some(...)}) for a step whose intended result must be proved, since the compact delta and a provider-neutral receipt come back together; omit postcondition when a changed/unchanged observation is enough to decide. fill(element_token, text) writes a field without a keyboard and proves it by read-back; submit(element_token) performs Enter without a keyboard; route(intent, target) selects the strongest proven route for exact, text, control, page, pointer, keyboard, menu or visual work, while routes(target) returns the complete capability set. Chain steps in one program when each follows from the last without your judgement, with expect() guarding assumptions and until() waiting for the screen; return when the next action needs model judgement. When the intent has a command, script({language, source}) runs AppleScript or JXA and shell({command}) runs a command line, both without touching focus; a Finder listing is one line there and eleven windows of accessibility on the GUI route. A window is about 800 tokens as view() lines and about 12,000 as get_window_state JSON: read with view, and use get_window_state when you need frames, actions or the screenshot. \`state\` persists between programs of this MCP client (the helpers keep state.target and state.last there); \`console.log(value)\` adds a text block; \`emitImage(result)\` adds the image a result carries (get_window_state with its screenshot, zoom) with its snapshot receipt; \`artifacts.save(name, value)\` writes a value or image to a file and returns its path. Your session identity is supplied automatically and cannot collide with another task; never pass session.

Long tasks: \`checkpoint({objective?, location?, remember?, completed?, pending?})\` keeps the bounded working set a later cell needs and \`recall()\` reads it. Store constraints, discoveries and evidence receipts there; put raw trees, screenshots and long prose in artifacts instead. Grounding: an element_token alone addresses an action, because Mako remembers which pid and window produced each snapshot; every read (view, act, until, get_window_state) takes a new snapshot and invalidates the earlier tokens for that window. Never carry a token by role or label: duplicate or reordered controls can make that target unsafe. fill() returns view, the exact newest lines from its read-back, so take the next token from written.view before another action. Screenshot coordinates are window-local pixels of that window's latest capture (element frames are screen points: subtract window_bounds and multiply by screenshot_scale); for a small target zoom a region and pass from_zoom:true with coordinates read off the zoom image. Reobserve after acting: transport success is not proof the UI changed, and a timeout or cancellation does not prove an action did not run. A stale token or a missing window means rediscover, never another window.

Background input, in order (details in mako_computer_help().routes): 1 accessibility — fill, set_value and element_token clicks (action press/pick/confirm/open), for anything an observed element exposes; this is how a backgrounded Electron or Chromium field is written, since set_value replaces text where a keyboard would select-all and retype. 2 page route — launch_app({bundle_id, page_route: true}) starts an Electron or Chromium app in the background with a private DevTools port and registers it as browser 'app:<bundle_id>'; the browser object is available in every computer program (browser.tabs({browser}), browser.select, browser.click, browser.type, browser.press, browser.observe, browser.screenshot), with keyboard, pointer, DOM reads and screenshots that never touch focus. 3 command — script and shell. 4 window pointer with x,y. 5 pid keyboard (type_text, press_key, hotkey): native Cocoa fields only and never a Cmd chord — Mako refuses a background Cmd chord before it is posted because the installed keyboard path has not passed background Command delivery acceptance (force: true posts it anyway); a Chromium or Electron renderer that is not frontmost drops every posted key; the driver cannot read keys back, so send them through act() and let the delta say whether they landed, and treat mako_routes.status 'unconfirmed' as a reason to read, not to retry. 6 invoke_menu for a menu item or its shortcut: the driver fronts the application for the call and restores the previous frontmost app itself, so it requires foreground: true and reports fronted.ms. 7 delivery_mode:'foreground' with foreground: true: Mako verifies that the exact application and window are already frontmost and refuses otherwise; bring_to_front requires foreground: true too. Mako never fronts on its own, and a result never asks you to: the user is working in another application. Electron and Chromium windows ignore background scrolling on macOS; use their page route. Do not repeat text based on delivered_chars alone: the driver can report zero when the field received everything.

Results: every action resolves to the driver's structured data, and a refused action throws with the driver's message (Mako's own refusals — a fronting call without foreground: true, a background Cmd chord — throw before the driver is asked); images ride on result.content. A call that fronted carries fronted: {pid, ms}, and mako_computer_status counts them for the task. list_windows rows carry kind: document, helper or unknown, and helper strips are not windows. get_window_state omits the application's menu bar and the duplicate tree_markdown (include_menu_bar:true and include_markdown:true restore them) and defaults max_elements to ${DEFAULT_MAX_ELEMENTS}. A returned or logged value at or past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB, and every image after the ${INLINE_IMAGE_COUNT}th in one program, is written whole to a file and the result carries a receipt with the path, size, hash and an outline of the value's shape; nothing is cut. Programs stop after ${PROGRAM_TIME_LIMIT_MS / 1000} seconds; on timeout, cancellation or an error the worker and \`state\` reset while the driver session, snapshots and Mako's checks remain. Scripts are trusted local code, not an OS sandbox; every action still passes Mako's session, snapshot, path, foreground and preview checks.

Output and input file paths (screenshot_out_file, output_dir, destination_root, files) may be absolute, ~-rooted or relative to the working directory; Mako resolves symlinked parents such as /tmp before the driver inspects them. macOS permissions, Chrome debugging consent and provider tool approval are distinct.`
const controlInstructions = `Mako control is one provider-neutral code API. Use bound window/tab handles through mako_control_exec; call mako_control_help for methods. Store handles in state across cells. control.apps/windows/browsers/tabs discover only missing targets; control.window({pid,window_id}) binds a known window, control.openTab({url}) creates a task page in the Settings preferred browser; an explicit browser overrides it. Missing or disconnected preferences never fall back. For Mako development choose the browser row whose desk origin/sourceRoot matches the requested checkout; never substitute the installed app.
Observe explicitly: const view=await state.tab.observe(); const field=view.get({role:'textbox',name:'Email'}); await state.tab.setValue(field.ref,'alice@example.com'); return await state.tab.expect({role:'textbox',name:'Email',value:'alice@example.com'}). Observe again before using another ref. Refusal throws before dispatch; timeout/cancellation can mean unknown outcome. Never replay uncertain or non-idempotent input. A dispatched receipt is not verification.
Observations keep structured nodes local and return compact lines once. Return view.select(...) or view.diff(previous) for smaller output; emitImage(await handle.screenshot()) only when needed. Oversized output spills whole to artifacts. Await all actions; late callbacks are refused. Ordinary errors retain state, timeout/cancellation reset it. checkpoint/recall store bounded JSON facts. Background input never fronts implicitly; browser and native permissions stay separate. Scripts are trusted local JavaScript, not an OS sandbox. The old control.act/observe/advanced and page APIs have been replaced. Read help to migrate; do not retry an old action.`
const toolInputSchema = z.object({
  properties: z.record(z.string(), z.json()).optional(),
  required: z.array(z.string()).optional(),
})
// Loose on purpose: the driver's own annotations and metadata pass through.
const toolResultSchema = z.looseObject({
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      })
    )
    .optional(),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
})
const captureFileSchema = z.object({
  screenshot_file_path: z.string().min(1),
  screenshot_mime_type: z.enum(["image/png", "image/jpeg"]).optional(),
})
const tokenSchema = z.string().regex(/^(s[0-9a-f]{8}):\d+$/)
const snapshotIdSchema = z.string().regex(/^s[0-9a-f]{8}$/)
const positiveInteger = z.number().int().positive()
const MAX_PREVIEW_FILE_BYTES = 6 * 1024 * 1024
export const COMPUTER_TOOL_INPUTS = {
  status: z.object({}).strict(),
  exec: ControlProgramRequestSchema,
  help: z
    .object({
      tool: z
        .string()
        .optional()
        .describe(
          "A computer action name. Returns its full input and output schema, description and Mako's notes."
        ),
    })
    .strict(),
}
const controlHelpInputSchema = z
  .object({
    tool: z
      .string()
      .optional()
      .describe("Native driver action whose live schema is needed."),
    domain: z
      .string()
      .optional()
      .describe("Chrome DevTools Protocol domain to inspect for tab.cdp."),
    method: z
      .string()
      .optional()
      .describe("Command in domain whose exact protocol schema to return."),
  })
  .refine((value) => value.method === undefined || value.domain !== undefined, {
    message: "method requires domain",
  })
  .strict()
const computerArgumentsSchema = z.record(z.string(), z.json())
type ComputerArguments = z.infer<typeof computerArgumentsSchema>
const programImageSchema = z.object({
  data: z.string().max(24 * 1024 * 1024),
  mimeType: z.enum(["image/png", "image/jpeg"]),
})
const programImageReceiptSchema = z.object({
  view: z.string().optional(),
  target: z.json().optional(),
  coordinates: z.json().optional(),
  snapshot_id: z.string().optional(),
  pid: z.number().int().positive().optional(),
  window_id: z.number().int().positive().optional(),
  screenshot_scale: z.number().positive().optional(),
})
const FRONTING_NOTE_ACTIONS: ReadonlySet<string> = new Set([
  "invoke_menu",
  "bring_to_front",
])
/** Keys the driver repeats in every window-state result that agents rarely need. */
const VERBOSE_WINDOW_STATE_KEYS = ["tree_markdown", "_note"]
/**
 * The SDK types a tool's schemas structurally, with members that may be
 * `undefined`; the reference renderer reads plain JSON. One round trip.
 */
function asDriverTool(tool: Tool): DriverTool {
  const json = (value: Tool["inputSchema"] | Tool["outputSchema"]) =>
    z.json().parse(JSON.parse(JSON.stringify(value)))
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: json(tool.inputSchema),
    outputSchema:
      tool.outputSchema === undefined ? undefined : json(tool.outputSchema),
  }
}

export type ComputerBackend = ComputerDriverProcess

export interface ComputerToolsServerOptions {
  surface?: "driver" | "control"
  browserCall?: BrowserCall
}

/** Read a capture the agent asked the driver to write to disk, for the preview only. */
async function previewFromFile(
  path: string,
  mimeType: "image/png" | "image/jpeg" | undefined
): Promise<ControlImage | undefined> {
  try {
    if ((await stat(path)).size > MAX_PREVIEW_FILE_BYTES) return undefined
    const data = (await readFile(path)).toString("base64")
    return ControlImageSchema.parse({
      data,
      mimeType:
        mimeType ?? (/\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png"),
    })
  } catch {
    return undefined
  }
}

type StructuredContent = NonNullable<
  z.infer<typeof toolResultSchema>["structuredContent"]
>

function withoutKeys(
  value: StructuredContent,
  keys: readonly string[]
): StructuredContent {
  const next: StructuredContent = {}
  for (const [key, entry] of Object.entries(value))
    if (!keys.includes(key)) next[key] = entry
  return next
}

/** Rewrite a result's structured data and its text echo together. */
function withStructured(
  result: z.infer<typeof toolResultSchema>,
  rewrite: (value: StructuredContent) => StructuredContent
): z.infer<typeof toolResultSchema> {
  if (!result.structuredContent) return result
  const echo = JSON.stringify(result.structuredContent)
  const structuredContent = rewrite(result.structuredContent)
  return {
    ...result,
    structuredContent,
    content: (result.content ?? []).map((block) =>
      block.type === "text" && block.text === echo
        ? { type: "text", text: JSON.stringify(structuredContent) }
        : block
    ),
  }
}

/**
 * The driver answers a window-state call twice: a Markdown tree in the text
 * block and the structured elements (plus the same tree again) in
 * structuredContent, with the application's menu bar among the elements.
 * Providers hand whichever they prefer to the model, so both become one
 * compact JSON document of the window's own elements unless asked otherwise.
 */
function compactWindowState(
  result: z.infer<typeof toolResultSchema>,
  keep: { includeMarkdown: boolean; includeMenuBar: boolean }
): z.infer<typeof toolResultSchema> {
  if (!result.structuredContent) return result
  const trimmed = keep.includeMarkdown
    ? result.structuredContent
    : withoutKeys(result.structuredContent, VERBOSE_WINDOW_STATE_KEYS)
  const structuredContent = keep.includeMenuBar
    ? trimmed
    : withoutMenuBar(trimmed)
  // Keep the driver's block order: the first text block becomes the JSON
  // document and any further text block is dropped.
  let replaced = false
  const content = (result.content ?? []).flatMap((block) => {
    if (block.type !== "text") return [block]
    if (replaced) return []
    replaced = true
    return [{ type: "text", text: JSON.stringify(structuredContent) }]
  })
  if (!replaced)
    content.unshift({ type: "text", text: JSON.stringify(structuredContent) })
  return { ...result, content, structuredContent }
}

/**
 * A keyboard result that the driver could not confirm carries Mako's
 * reading of it: dropped outright (`delivery_failed`) or merely unverified,
 * and in both cases the routes that can do the job.
 */
function withKeyRouteAdvice(
  result: z.infer<typeof toolResultSchema>
): z.infer<typeof toolResultSchema> {
  const advice = result.isError
    ? undefined
    : keyRouteAdvice(result.structuredContent)
  if (!advice) return result
  const structuredContent = {
    ...result.structuredContent,
    mako_routes: advice,
  }
  return {
    ...result,
    structuredContent,
    content: [
      ...(result.content ?? []).filter((block) => block.type !== "text"),
      { type: "text", text: JSON.stringify(structuredContent) },
    ],
  }
}

function computerProgramImage(
  value: z.infer<typeof z.json>
): ControlProgramOutput[] {
  const direct = programImageSchema.safeParse(value)
  if (direct.success) {
    const receipt = programImageReceiptSchema.parse(value)
    return [
      ...(Object.keys(receipt).length
        ? [{ type: "text" as const, text: JSON.stringify(receipt) }]
        : []),
      { type: "image", ...direct.data },
    ]
  }
  const result = toolResultSchema.safeParse(value)
  const image = result.success
    ? result.data.content
        ?.map((block) => programImageSchema.safeParse(block))
        .find((candidate) => candidate.success)
    : undefined
  if (!result.success || !image?.success)
    throw new Error(
      "emitImage expects an image content block or a computer tool result containing one"
    )
  // A program hands over either the driver's MCP result or, more often,
  // the data it resolved to, whose receipt fields sit at the top level.
  const receipt = programImageReceiptSchema.safeParse(
    result.data.structuredContent ?? result.data
  )
  return [
    ...(receipt.success && Object.keys(receipt.data).length > 0
      ? [{ type: "text" as const, text: JSON.stringify(receipt.data) }]
      : []),
    { type: "image", ...image.data },
  ]
}

function makoNotes(tool: Tool): string[] {
  const input = toolInputSchema.parse(tool.inputSchema)
  const notes: string[] = []
  if (tool.name === "get_window_state")
    notes.push(
      `Mako defaults max_elements to ${DEFAULT_MAX_ELEMENTS} and omits the menu bar and tree_markdown unless include_menu_bar or include_markdown is true. view(target) reads the same window as compact lines. Pass max_elements:1 for a screenshot-only capture. A result past the inline budget is written to a file and outlined, never cut.`
    )
  if (tool.name === "list_windows")
    notes.push(
      "Every row carries kind: document, helper or unknown. Untitled strips no taller or wider than a toolbar are helpers, not windows; windows(pid) returns the rest."
    )
  if (input.properties?.element_token)
    notes.push(
      "An element_token alone is enough: Mako supplies the pid and window_id of the snapshot that produced it."
    )
  if (input.properties?.delivery_mode)
    notes.push(
      "Input route: background by default and never fronts the window. delivery_mode:'foreground' requires foreground: true on the call; Mako then verifies that this exact application and window are already frontmost and refuses otherwise. It never escalates automatically."
    )
  if (tool.name === "launch_app")
    notes.push(
      "page_route: true (Mako) launches an Electron or Chromium bundle in the background with a private DevTools port and registers it as browser 'app:<bundle_id>' for the browser object; add app_path for an unregistered .app."
    )
  if (KEYBOARD_TOOLS.has(tool.name))
    notes.push(
      KEY_ROUTE_ADVICE.unconfirmed.reason,
      KEY_ROUTE_ADVICE.unconfirmed.routes,
      KEY_ROUTE_ADVICE.unverifiable.reason
    )
  if (FRONTING_NOTE_ACTIONS.has(tool.name))
    notes.push(
      "This call takes the user's screen (the driver fronts the application) and requires foreground: true; the result reports fronted: {pid, ms}."
    )
  return notes
}

const scriptInputSchema = z.object({
  language: z.enum(["applescript", "jxa"]).default("applescript"),
  source: z.string().min(1).max(200_000),
  timeout_ms: z.number().int().min(100).max(55_000).default(20_000),
})
const shellInputSchema = z.object({
  command: z.string().min(1).max(200_000),
  cwd: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(100).max(55_000).default(20_000),
})
const pageRouteLaunchSchema = z.object({
  bundle_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  app_path: z.string().min(1).optional(),
  additional_arguments: z.array(z.string()).default([]),
  urls: z.array(z.string()).default([]),
})
const versionSchema = z.object({ webSocketDebuggerUrl: z.string().url() })
const windowRowsSchema = z.looseObject({
  windows: z.array(
    z.looseObject({
      window_id: z.number().int().optional(),
      kind: z.string().optional(),
      is_on_screen: z.boolean().nullable().optional(),
    })
  ),
})
const nativeElementSchema = ElementSchema.extend({
  value_exact: z.boolean().optional(),
  in_web_content: z.boolean().optional(),
  depth: z.number().int().nonnegative().default(0),
})
const nativeViewSchema = z.looseObject({
  snapshot_id: z.string(),
  elements: z.array(z.json()).default([]),
})
const pageViewSchema = z.looseObject({
  observation: z.string(),
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Zod schema composition API.
  nodes: ControlObservationSchema.shape.nodes.default([]),
  viewport: z.json().nullable().optional(),
  matched: z.number().int().optional(),
  nextOffset: z.number().int().nullable().optional(),
  omitted: z.number().int().optional(),
})
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024
const PAGE_ROUTE_WAIT_MS = 15_000
const WINDOW_WAIT_MS = 10_000
const MAX_RUNNING_FRONTS = 64

interface CommandResult {
  stdout: string
  stderr: string
  exit_code: number | null
  ms: number
  timed_out: boolean
  truncated: boolean
}

/** One local command with bounded output; the program's spill handles the size. */
function runCommand(
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeout: number; input?: string },
  signal: AbortSignal
): Promise<CommandResult> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: COMMAND_OUTPUT_LIMIT,
        signal,
        env: { ...process.env, MAKO_CONTROL_TOKEN: "" },
      },
      (error, stdout, stderr) => {
        if (error && signal.aborted) {
          reject(error)
          return
        }
        const detail = z
          .object({
            code: z.union([z.string(), z.number()]).nullable().optional(),
            killed: z.boolean().optional(),
            signal: z.string().nullable().optional(),
          })
          .safeParse(error)
        const truncated =
          detail.success &&
          detail.data.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        const timedOut =
          detail.success &&
          detail.data.killed === true &&
          detail.data.signal === "SIGTERM" &&
          !truncated
        const exit =
          detail.success && z.number().int().safeParse(detail.data.code).success
            ? z.number().int().parse(detail.data.code)
            : error
              ? null
              : 0
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exit_code: exit,
          ms: Date.now() - started,
          timed_out: timedOut,
          truncated,
        })
      }
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = z.object({ port: z.number() }).parse(server.address()).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("aborted")
        )
      },
      { once: true }
    )
  })

/** The DevTools browser endpoint of a Chromium process once it listens. */
async function awaitDevTools(
  port: number,
  signal: AbortSignal
): Promise<string | undefined> {
  const deadline = Date.now() + PAGE_ROUTE_WAIT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal,
      })
      if (response.ok) {
        const version = versionSchema.safeParse(await response.json())
        if (version.success) return version.data.webSocketDebuggerUrl
      }
    } catch {
      // Not listening yet.
    }
    await wait(150, signal)
  }
  return undefined
}

/** The pid that owns a listening loopback port. */
async function listenerPid(
  port: number,
  signal: AbortSignal
): Promise<number | undefined> {
  const result = await runCommand(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { timeout: 5_000 },
    signal
  )
  const pid = Number(result.stdout.trim().split(/\s+/)[0])
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

const runningApplicationSchema = z.object({
  bundle_id: z.string().nullable(),
  bundle_path: z.string(),
})

/** Bundle identity independently reported by AppKit for an exact live pid. */
async function runningApplication(
  pid: number,
  signal: AbortSignal
): Promise<z.infer<typeof runningApplicationSchema>> {
  const source = `ObjC.import("AppKit"); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${String(pid)}); if (!app) throw new Error("pid is not an NSRunningApplication"); const unwrap = value => value ? ObjC.unwrap(value) : null; JSON.stringify({bundle_id: unwrap(app.bundleIdentifier), bundle_path: unwrap(app.bundleURL.path)})`
  const result = await runCommand(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", source],
    { timeout: 5_000 },
    signal
  )
  if (result.exit_code !== 0)
    throw new Error(
      `Could not verify the application owning DevTools pid ${String(pid)}: ${result.stderr.trim() || "AppKit returned no identity"}.`
    )
  return runningApplicationSchema.parse(JSON.parse(result.stdout.trim()))
}

function routeIdentity(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-")
  return cleaned.replace(/^-+|-+$/g, "") || "application"
}

export interface PageRoute {
  browser: string | null
  endpoint: string
  bundle_id: string
  name: string
  [key: string]: string | null
}

export function createComputerToolsServer(
  backend?: ComputerBackend,
  taskId = process.env.MAKO_TASK_ID ?? randomUUID(),
  connectDriver: ComputerDriverConnector = connectMcpComputerDriver,
  options: ComputerToolsServerOptions = {}
): Server {
  const unified = options.surface !== "driver"
  const toolPrefix = unified ? "mako_control" : "mako_computer"
  const namespace = unified ? "control" : "computer"
  const observations = new ComputerObservationClient()
  const artifacts = controlArtifactsDirectory(namespace, taskId)
  let client: ComputerDriverClient | undefined
  let closed = false
  let starting: Promise<Tool[]> | undefined
  let runtime: ControlProgramRuntime | undefined
  // The driver binds a session to the MCP transport that created it, so a
  // reconnect must mint a fresh id; the task id keeps it distinct from others.
  let session = `mako-${taskId}-${randomUUID().slice(0, 8)}`
  // The driver wants the pid and window that produced a snapshot, and
  // honours tokens from a window's newest snapshot only; remember each
  // Snapshot identity lets a token alone recover its exact pid and window.
  // Tokens are never remapped by role or label: a duplicate or reordered
  // control would make that guess unsafe.
  const snapshots = new Map<string, SnapshotIndex>()
  // Every call that took the screen, counted for the task; and the page
  // routes of the Electron or Chromium applications this task launched.
  let frontingEvents = 0
  const pageRoutes = new Map<number, PageRoute>()
  const controlViews = new Map<
    string,
    { observation: string; lines: string[] }
  >()
  const controlUncertain = new Set<string>()
  const controlVisuals = new Map<string, string>()
  const controlRefs = new Map<
    string,
    { target: string; observation: string; webText?: boolean }
  >()
  const controlEvents: Array<{
    cursor: number
    at: number
    target: string
    kind: string
    detail: ComputerArguments
  }> = []
  let controlEventCursor = 0
  const asyncNativeGuard = process.env.MAKO_CONTROL_ASYNC_GUARD === "1"
  const controlTargetKey = (target: ControlTarget) => JSON.stringify(target)
  const invalidateControlTarget = (key: string) => {
    controlViews.delete(key)
    controlVisuals.delete(key)
    for (const [ref, binding] of controlRefs)
      if (binding.target === key) controlRefs.delete(ref)
  }
  const rememberControlRefs = (
    target: ControlTarget,
    observation: string,
    lines: readonly string[]
  ) => {
    const key = controlTargetKey(target)
    for (const [ref, binding] of controlRefs)
      if (binding.target === key) controlRefs.delete(ref)
    for (const line of lines) {
      try {
        controlRefs.set(controlLineRef(line), { target: key, observation })
      } catch {
        continue
      }
    }
    while (controlViews.size > 64) {
      const oldest = controlViews.keys().next().value
      if (oldest === undefined) break
      invalidateControlTarget(oldest)
    }
    while (controlRefs.size > 2_048) {
      const oldest = controlRefs.keys().next().value
      if (oldest === undefined) break
      controlRefs.delete(oldest)
    }
  }
  const pushControlEvent = (
    target: ControlTarget,
    kind: string,
    detail: ComputerArguments
  ) => {
    if (kind === "topology") invalidateControlTarget(controlTargetKey(target))
    controlEventCursor++
    controlEvents.push({
      cursor: controlEventCursor,
      at: Date.now(),
      target: controlTargetKey(target),
      kind,
      detail,
    })
    if (controlEvents.length > 128) controlEvents.splice(0, 32)
  }
  const detachPageRoute = async (route: PageRoute): Promise<void> => {
    if (!browserCall || route.browser === null) return
    await browserCall(
      BrowserCommandSchema.parse({ action: "detach", id: route.browser }),
      AbortSignal.timeout(2_000)
    ).catch(() => {})
  }
  const removePageRoute = async (pid: number): Promise<void> => {
    const route = pageRoutes.get(pid)
    if (!route) return
    pageRoutes.delete(pid)
    await detachPageRoute(route)
  }
  const pageRouteValue = async (): Promise<Record<string, PageRoute>> => {
    if (browserCall) {
      try {
        const statuses = z
          .array(z.looseObject({ id: z.string() }))
          .parse(
            await browserCall(
              BrowserCommandSchema.parse({ action: "status" }),
              AbortSignal.timeout(2_000)
            )
          )
        const live = new Set(statuses.map((entry) => entry.id))
        for (const [pid, route] of pageRoutes)
          if (route.browser !== null && !live.has(route.browser))
            pageRoutes.delete(pid)
      } catch {
        // A browser-control outage does not prove that its attached app died.
      }
    }
    return Object.fromEntries(
      [...pageRoutes].map(([pid, route]) => [String(pid), route])
    )
  }
  const closePageRoutes = async (): Promise<void> => {
    await Promise.all([...pageRoutes.keys()].map(removePageRoute))
  }
  // The driver draws an animated "agent cursor" on the user's screen and
  // glides it to every target before acting, awaiting the glide. Measured
  // 2026-09-14 on driver 0.28.0 against Cocoa and Electron windows: a
  // click or set_value on a different element than the last one took
  // 2.5 s and a repeat on the same element 0.1–1.1 s, `move_cursor` alone
  // 1.5–2.5 s by distance; `enabled: false` hides the overlay but the
  // glide is still awaited. `glide_duration_ms: 1` (0 means the physics
  // default) ends the glide at once: 20 ms per move, ~1.0 s per click,
  // the rest being the driver's one-second poll for new windows. Mako
  // sets that once per session, before the first call that names the
  // session and again after a session start (which resets it), and hides
  // the overlay because background work should move nothing on the
  // user's desk; a program can show it again on purpose.
  let cursorQuietedFor: string | undefined
  const SESSION_START_TOOLS = new Set(["start_session", "escalate_session"])
  const QUIET_CURSOR_MOTION = { glide_duration_ms: 1, dwell_after_click_ms: 0 }
  const quietAgentCursor = async (signal: AbortSignal | undefined) => {
    const connection = client
    if (!connection) return
    cursorQuietedFor = session
    for (const [name, rest] of [
      ["set_agent_cursor_motion", QUIET_CURSOR_MOTION],
      ["set_agent_cursor_enabled", { enabled: false }],
    ] as const) {
      try {
        await connection.callTool(
          name,
          { session, ...rest },
          {
            signal,
            timeout: 10_000,
          }
        )
      } catch {
        // A driver without the cursor, or one that refuses: the action
        // itself decides whether this session works.
      }
    }
  }
  const AGENT_CURSOR_TOOLS = new Set([
    "set_agent_cursor_enabled",
    "set_agent_cursor_motion",
    "set_agent_cursor_theme",
    "get_agent_cursor_state",
  ])
  // The host's browser control, when a Mako task lent it: page routes are
  // registered there and programs get the browser object through it.
  const browserCall =
    options.browserCall ??
    (process.env.MAKO_CONTROL_URL && process.env.MAKO_CONTROL_TOKEN
      ? browserControlClient()
      : undefined)
  const tools = () => {
    starting ??= (async () => {
      if (closed) throw new Error("Computer control connection is closed")
      if (!backend) return []
      const connection = await connectDriver(backend)
      client = connection
      session = `mako-${taskId}-${randomUUID().slice(0, 8)}`
      snapshots.clear()
      controlViews.clear()
      controlRefs.clear()
      controlUncertain.clear()
      controlVisuals.clear()
      connection.onClose(() => {
        if (client !== connection) return
        starting = undefined
        void runtime?.close()
        runtime = undefined
      })
      try {
        return await connection.listTools()
      } catch (error) {
        await connection.close()
        throw error
      }
    })().catch((error) => {
      starting = undefined
      throw error
    })
    return starting
  }
  const status = async (): Promise<ComputerArguments> =>
    unified
      ? {
          available: Boolean(backend || browserCall),
          version: 2,
          native: { configured: Boolean(backend), catalog: "help({tool})" },
          browser: { configured: Boolean(browserCall) },
          program: `${toolPrefix}_exec`,
          help: `${toolPrefix}_help`,
          input:
            "background by default; foreground requires explicit preflight",
          artifacts,
        }
      : {
          available: Boolean(backend),
          driverTools: (await tools()).length,
          program: `${toolPrefix}_exec`,
          helpers: [
            "view",
            "act",
            "until",
            "expect",
            "token",
            "windows",
            "fill",
            "submit",
            "routes",
            "route",
          ],
          makoActions: MAKO_ACTIONS.map((tool) => tool.name),
          browser: browserCall
            ? "browser.<action> available in programs"
            : "unavailable outside a Mako task",
          agentCursor:
            "quiet for every Mako session: glide_duration_ms 1, no dwell, hidden (the driver's awaited cursor glide cost 1.5 s of every action on a new element and moved on the user's screen); computer.set_agent_cursor_enabled({enabled: true}) shows it",
          help: `${toolPrefix}_help`,
          inputRoutes: {
            default: "background",
            order: BACKGROUND_INPUT_LADDER.map((rung) => rung.route),
            foreground: "explicit-preflight",
            preflight: [
              "foreground-flag",
              "active-application",
              "front-window",
            ],
            automaticEscalation: false,
            backgroundCmdChords: "refused before dispatch unless force: true",
          },
          frontingEvents,
          pageRoutes: await pageRouteValue(),
          artifacts,
        }
  const help = async (args: z.infer<typeof COMPUTER_TOOL_INPUTS.help>) => {
    const available = await tools()
    const all = [...MAKO_ACTIONS, ...available.map(asDriverTool)]
    if (args.tool !== undefined) {
      const tool = all.find((candidate) => candidate.name === args.tool)
      if (!tool)
        throw new Error(
          `Unknown computer action "${args.tool}". Actions: ${all.map((candidate) => candidate.name).join(", ")}.`
        )
      const { properties, required } = programProperties(tool)
      const driverTool = available.find(
        (candidate) => candidate.name === tool.name
      )
      return {
        action: tool.name,
        signature: signatureOf(tool),
        description: tool.description ?? "",
        notes: driverTool ? makoNotes(driverTool) : [],
        inputSchema: {
          type: "object",
          properties,
          required,
        },
        outputSchema:
          tool.outputSchema === undefined
            ? undefined
            : normalizeDriverSchema(tool.outputSchema),
        annotations: driverTool?.annotations,
      }
    }
    return {
      actions: all.map((tool) => ({
        action: tool.name,
        signature: signatureOf(tool),
        summary: summaryOf(tool),
      })),
      routes: BACKGROUND_INPUT_LADDER,
      reference: renderReference(available.map(asDriverTool)),
      program:
        "Every action is computer.<action>({...}) inside mako_computer_exec, beside the helpers view, act, until, expect, token, windows, fill, submit, routes and route and the browser object; call help({tool}) for one action's full schema.",
    }
  }
  const rememberSnapshot = (
    structuredContent: z.infer<typeof toolResultSchema>["structuredContent"]
  ) => {
    if (structuredContent === undefined) return
    const snapshot = indexSnapshot(structuredContent)
    if (!snapshot) return
    if (snapshots.size >= 64) {
      const oldest = snapshots.keys().next().value
      if (oldest !== undefined) snapshots.delete(oldest)
    }
    snapshots.set(snapshot.snapshot_id, snapshot)
  }
  const invokeTool = async (
    name: string,
    inputArguments: ComputerArguments,
    signal: AbortSignal
  ) => {
    const available = await tools()
    const connection = client
    if (!connection)
      throw new Error("Computer control connection is unavailable")
    const tool = available.find((candidate) => candidate.name === name)
    if (!tool)
      throw new Error(
        `Unknown computer action "${name}". Actions: ${available.map((candidate) => candidate.name).join(", ")}.`
      )
    const input = toolInputSchema.parse(tool.inputSchema)
    const args = await resolveDriverPaths(inputArguments)
    delete args.session
    if (input.properties?.session) args.session = session
    const hasCursor = available.some(
      (candidate) => candidate.name === "set_agent_cursor_enabled"
    )
    if (
      hasCursor &&
      input.properties?.session &&
      cursorQuietedFor !== session &&
      !AGENT_CURSOR_TOOLS.has(tool.name) &&
      !SESSION_START_TOOLS.has(tool.name)
    )
      await quietAgentCursor(signal)
    // Mako's refusals come before the driver is asked: a fronting call
    // without its declaration, a background Cmd chord.
    const refusal = refusalFor(tool.name, computerArgumentsSchema.parse(args))
    if (refusal) throw new Error(refusal.message)
    const includeMarkdown = args.include_markdown === true
    const includeMenuBar = args.include_menu_bar === true
    for (const flag of makoFlagNames(tool.name)) delete args[flag]
    if (tool.name === "get_window_state" && args.max_elements === undefined)
      args.max_elements = DEFAULT_MAX_ELEMENTS
    const token = tokenSchema.safeParse(args.element_token)
    const snapshotId = token.success
      ? token.data.split(":")[0]
      : snapshotIdSchema.safeParse(args.snapshot_id).data
    const remembered = snapshotId ? snapshots.get(snapshotId) : undefined
    if (remembered) {
      if (input.properties?.pid && !positiveInteger.safeParse(args.pid).success)
        args.pid = remembered.pid
      if (
        input.properties?.window_id &&
        !positiveInteger.safeParse(args.window_id).success
      )
        args.window_id = remembered.window_id
    }
    if (args.delivery_mode === "foreground" && input.properties?.pid)
      await verifyForegroundInput(connection, args, signal)
    const capturedWindow = AppshotTargetSchema.safeParse({
      pid: args.pid,
      windowId: args.window_id,
    }).data
    const target = `Window ${String(args.window_id ?? "selected")} · app ${String(args.pid ?? "selected")}`
    observations.submit({
      operation: tool.name,
      target,
      status: "running",
      window: capturedWindow,
    })
    const startedAt = Date.now()
    const raw = toolResultSchema.parse(
      await connection.callTool(
        tool.name,
        computerArgumentsSchema.parse(args),
        {
          signal,
          timeout: 60_000,
        }
      )
    )
    if (tool.name === "get_window_state")
      rememberSnapshot(raw.structuredContent)
    // A session start resets the session's cursor; quiet it again.
    if (hasCursor && SESSION_START_TOOLS.has(tool.name) && !raw.isError)
      await quietAgentCursor(signal)
    const projected =
      tool.name === "get_window_state"
        ? compactWindowState(raw, { includeMarkdown, includeMenuBar })
        : tool.name === "list_windows"
          ? withStructured(raw, withWindowKinds)
          : KEYBOARD_TOOLS.has(tool.name)
            ? withKeyRouteAdvice(raw)
            : raw
    // A call that took the screen says so and is counted; the driver's own
    // nudge towards the foreground never reaches the model.
    const fronted =
      !projected.isError &&
      deliveredForeground(tool.name, projected.structuredContent)
    if (fronted && frontingEvents < Number.MAX_SAFE_INTEGER) frontingEvents++
    const pid = positiveInteger.safeParse(args.pid).data
    const result = withStructured(projected, (value) => {
      const stripped = withoutEscalationNudge(value)
      if (!fronted) return stripped
      const receipt: StructuredContent = { ms: Date.now() - startedAt }
      if (pid !== undefined) receipt.pid = pid
      return { ...stripped, fronted: receipt }
    })
    const inline = result.content?.find((block) => block.type === "image")
    const file = captureFileSchema.safeParse(result.structuredContent).data
    const image =
      ControlImageSchema.safeParse(inline).data ??
      (file
        ? await previewFromFile(
            file.screenshot_file_path,
            file.screenshot_mime_type
          )
        : undefined)
    observations.submit({
      operation: tool.name,
      target,
      status: result.isError ? "error" : "observed",
      image,
      window: capturedWindow,
    })
    return result
  }
  /**
   * An Electron or Chromium application launched with a private DevTools
   * port and registered with Mako's browser control, so its pages are
   * driven in the background through the browser object. The driver's own
   * launch_app refuses the flag on principle (an unproven user profile);
   * Mako launches the bundle itself the way it launches the driver, with
   * `open -g -n`, so the application never activates.
   */
  const launchWithPageRoute = async (
    rawArguments: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = pageRouteLaunchSchema.parse(rawArguments)
    const bundleId = request.bundle_id
    if (!bundleId && !request.app_path)
      throw new Error(
        "launch_app with page_route: true needs bundle_id (or app_path to a .app bundle); a name is not exact enough to launch with a debugging port."
      )
    const port = await freePort()
    const label =
      request.app_path !== undefined
        ? basename(request.app_path, ".app")
        : (request.name ?? bundleId?.split(".").at(-1) ?? "app")
    const requestedIdentity = bundleId ?? label
    const launch = await runCommand(
      "/usr/bin/open",
      [
        "-g",
        "-n",
        ...(request.app_path !== undefined
          ? ["-a", request.app_path]
          : ["-b", z.string().parse(bundleId)]),
        ...request.urls,
        "--args",
        ...request.additional_arguments,
        `--remote-debugging-port=${port}`,
      ],
      { timeout: 15_000 },
      signal
    )
    if (launch.exit_code !== 0)
      throw new Error(
        `launch_app could not open ${requestedIdentity}: ${launch.stderr.trim() || `open exited ${String(launch.exit_code)}`}`
      )
    const endpoint = await awaitDevTools(port, signal)
    if (!endpoint)
      throw new Error(
        `${requestedIdentity} was launched but no DevTools endpoint answered on 127.0.0.1:${port} within ${PAGE_ROUTE_WAIT_MS / 1000} s: it is not an Electron or Chromium application, or it ignored --remote-debugging-port. The application may be running; list_apps shows it, and the driver's own routes reach it.`
      )
    const pid = await listenerPid(port, signal)
    if (pid === undefined)
      throw new Error(
        `${requestedIdentity} answers on 127.0.0.1:${port} but no process owns the port; lsof could not read it.`
      )
    const application = await runningApplication(pid, signal)
    if (bundleId && application.bundle_id !== bundleId)
      throw new Error(
        `The DevTools endpoint belongs to ${application.bundle_id ?? "an unidentified application"} (pid ${String(pid)}), not requested bundle ${bundleId}; Mako refused the route.`
      )
    if (request.app_path) {
      const [requestedPath, ownerPath] = await Promise.all([
        realpath(request.app_path),
        realpath(application.bundle_path),
      ])
      if (requestedPath !== ownerPath)
        throw new Error(
          `The DevTools endpoint belongs to ${ownerPath} (pid ${String(pid)}), not requested application ${requestedPath}; Mako refused the route.`
        )
    }
    const identity = application.bundle_id ?? requestedIdentity
    // Its first document window, so the caller can act without a list.
    const deadline = Date.now() + WINDOW_WAIT_MS
    let windows: z.infer<typeof windowRowsSchema>["windows"]
    for (;;) {
      const listed = windowRowsSchema.safeParse(
        toolResultData(await invokeTool("list_windows", { pid }, signal))
      )
      windows = listed.success ? listed.data.windows : []
      if (
        windows.some((row) => row.kind !== "helper") ||
        Date.now() >= deadline
      )
        break
      await wait(200, signal)
    }
    const browserId = `app:${routeIdentity(identity)}:${String(pid)}:${randomUUID().slice(0, 8)}`
    let browser: string | null = null
    let note: string
    if (browserCall) {
      await browserCall(
        BrowserCommandSchema.parse({
          action: "attach",
          id: browserId,
          name: `${label} (pid ${pid})`,
          endpoint,
        }),
        signal
      )
      browser = browserId
      note = `Drive its pages with the browser object: browser.tabs({browser: ${JSON.stringify(browserId)}}), then browser.select, browser.observe, browser.click, browser.type, browser.press, browser.screenshot with the returned target. Keyboard and pointer land in the background; nothing here fronts the application.`
    } else {
      note =
        "No Mako task lent browser control to this server, so the endpoint is not registered as a browser; a CDP client can connect to it directly."
    }
    const route: PageRoute = {
      browser,
      endpoint,
      bundle_id: identity,
      name: label,
    }
    pageRoutes.set(pid, route)
    if (pageRoutes.size > MAX_RUNNING_FRONTS) {
      const oldest = pageRoutes.keys().next().value
      if (oldest !== undefined) await removePageRoute(oldest)
    }
    return {
      pid,
      bundle_id: bundleId ?? null,
      name: label,
      launch_state: windows.some((row) => row.kind !== "helper")
        ? "window_ready"
        : "running",
      windows,
      page_route: { browser, endpoint, note },
    }
  }
  const makoAction = async (
    action: string,
    args: ComputerArguments,
    signal: AbortSignal
  ) => {
    if (action === "script") {
      const input = scriptInputSchema.parse(args)
      observations.submit({
        operation: "script",
        target: input.language,
        status: "running",
      })
      const result = await runCommand(
        "/usr/bin/osascript",
        input.language === "jxa" ? ["-l", "JavaScript", "-"] : ["-"],
        { timeout: input.timeout_ms, input: input.source },
        signal
      )
      observations.submit({
        operation: "script",
        target: input.language,
        status: result.exit_code === 0 ? "observed" : "error",
      })
      return result
    }
    if (action === "shell") {
      const input = shellInputSchema.parse(args)
      observations.submit({
        operation: "shell",
        target: input.command.slice(0, 80),
        status: "running",
      })
      const result = await runCommand(
        "/bin/sh",
        ["-c", input.command],
        { timeout: input.timeout_ms, cwd: input.cwd },
        signal
      )
      observations.submit({
        operation: "shell",
        target: input.command.slice(0, 80),
        status: result.exit_code === 0 ? "observed" : "error",
      })
      return result
    }
    if (action === "page_routes") return pageRouteValue()
    throw new Error(`Unknown Mako action "${action}"`)
  }
  const pageTarget = (target: PageTarget) => {
    return BrowserTargetSchema.parse({
      browser: target.browser,
      tab: target.tab,
      generation: target.generation,
      lease: target.lease,
    })
  }
  const nativeWindows = async (
    pid: number,
    signal: AbortSignal
  ): Promise<z.infer<typeof windowRowsSchema>["windows"]> => {
    return windowRowsSchema.parse(
      controlData(await invokeTool("list_windows", { pid }, signal))
    ).windows
  }
  const controlData = (result: Parameters<typeof toolResultData>[0]) => {
    const refused = toolResultError(result)
    if (refused !== undefined)
      throw new ControlFault("native-driver-error", refused, "unknown")
    return toolResultData(result)
  }
  const nativeCapabilities = async (
    target: WindowControlTarget,
    signal: AbortSignal
  ) => {
    const windows = await nativeWindows(target.pid, signal)
    const exact = windows.find(
      (window) => window.window_id === target.window_id
    )
    return windowCapabilities({
      target,
      documentWindows: windows.filter((window) => window.kind === "document")
        .length,
      onScreen: exact?.is_on_screen ?? null,
      pageBrowser: pageRoutes.get(target.pid)?.browser ?? undefined,
    })
  }
  const controlTargets = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlTargetsRequestSchema.parse(raw)
    if (request.kind === "browsers") {
      if (!browserCall)
        return { kind: request.kind, available: false, browsers: [] }
      return {
        kind: request.kind,
        available: true,
        browsers: await browserCall(
          BrowserCommandSchema.parse({ action: "status" }),
          signal
        ),
      }
    }
    if (request.kind === "pages") {
      if (!browserCall)
        throw new Error("Page control is unavailable outside a Mako task")
      return {
        kind: request.kind,
        browser: request.browser,
        pages: await browserCall(
          BrowserCommandSchema.parse({
            action: "tabs",
            browser: request.browser,
          }),
          signal
        ),
      }
    }
    if (request.kind === "apps")
      return controlData(await invokeTool("list_apps", {}, signal))
    return {
      kind: request.kind,
      pid: request.pid,
      windows: await nativeWindows(request.pid, signal),
    }
  }
  const controlObserve = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlObserveRequestSchema.parse(raw)
    const scope: ComputerArguments = { within: request.within }
    if (request.match) scope.match = request.match
    const key = controlTargetKey(request.target)
    invalidateControlTarget(key)
    if (request.target.kind === "page") {
      if (!browserCall)
        throw new Error("Page control is unavailable outside a Mako task")
      const value = pageViewSchema.parse(
        await browserCall(
          BrowserCommandSchema.parse({
            action: "observe",
            target: pageTarget(request.target),
            maxNodes: request.max,
            within: request.within,
            match: request.match,
            query: request.query,
            interactiveOnly: request.interactive,
          }),
          signal
        )
      )
      const lines = pageElementLines(value.nodes)
      const nodes = value.nodes.map((raw) => {
        const node = { ...raw }
        for (const state of [
          "checked",
          "disabled",
          "focused",
          "expanded",
          "selected",
          "required",
          "pressed",
          "readonly",
          "invalid",
          "modal",
          "multiselectable",
        ])
          if (node[state] === "true" || node[state] === "false")
            node[state] = node[state] === "true"
        return node
      })
      const coverage = {
        complete:
          value.omitted === 0 &&
          value.nextOffset == null &&
          !request.query &&
          !request.interactive,
        omitted: value.omitted ?? null,
        textComplete: value.truncatedTextFields === 0,
      }
      controlViews.set(key, { observation: value.observation, lines })
      rememberControlRefs(request.target, value.observation, lines)
      const result: ComputerArguments = {
        target: request.target,
        route: "page",
        observation: value.observation,
        lines,
        nodes,
        coverage,
        scope,
        viewport: value.viewport ?? null,
      }
      if (value.matched !== undefined) result.matched = value.matched
      if (value.nextOffset !== undefined) result.nextOffset = value.nextOffset
      if (value.omitted !== undefined) result.omitted = value.omitted
      controlUncertain.delete(key)
      return ControlObservationSchema.parse(result)
    }
    const state = nativeViewSchema.parse(
      controlData(
        await invokeTool(
          "get_window_state",
          {
            pid: request.target.pid,
            window_id: request.target.window_id,
            max_elements:
              request.within.length || request.match ? 1000 : request.max,
            include_screenshot: false,
          },
          signal
        )
      )
    )
    const availableLines = elementLines(state.elements, {
      interactive: request.interactive,
      query: request.query,
    })
    const visibleRefs = new Set(
      availableLines.map((line) => {
        try {
          return controlLineRef(line)
        } catch {
          return ""
        }
      })
    )
    const nativePageBrowser = pageRoutes.get(request.target.pid)?.browser
    const ancestors: Array<{ depth: number; role: string }> = []
    const allNodes = state.elements.flatMap((raw) => {
      const parsed = nativeElementSchema.safeParse(raw)
      if (!parsed.success) return []
      const element = parsed.data
      if (element.role.startsWith("AXMenu")) return []
      const node: z.infer<typeof ControlObservationSchema>["nodes"][number] = {
        depth: element.depth,
        role: element.role.replace(/^AX/, ""),
        name: element.label ?? "",
      }
      if (element.element_token) node.ref = element.element_token
      while (ancestors.length && ancestors.at(-1)!.depth >= node.depth)
        ancestors.pop()
      const web = element.in_web_content === true || ancestors.some((ancestor) => ancestor.role === "AXWebArea")
      ancestors.push({ depth: node.depth, role: element.role })
      if (
        ["TextField", "TextArea", "SearchField", "ComboBox"].includes(
          node.role ?? ""
        )
      ) {
        node.inputRoute = web ? "page" : "accessibility"
        if (web && nativePageBrowser) node.pageBrowser = nativePageBrowser
      }
      if (element.value != null) {
        node.value = String(element.value)
        // Older drivers normalize whitespace and substitute placeholders.
        node.valueExact = element.value_exact === true
      }
      if (element.enabled !== undefined) node.disabled = !element.enabled
      if (element.selected !== undefined) node.selected = element.selected
      return [node]
    })
    const scoped = scopeControlNodes(allNodes, request).filter(
      (node) =>
        !(request.interactive || request.query) ||
        visibleRefs.has(node.ref ?? "")
    )
    const nodes = scoped.slice(0, request.max)
    const returnedRefs = new Set(nodes.map((node) => node.ref))
    const webRefs = new Set(
      nodes.filter((node) => node.inputRoute === "page").map((node) => node.ref)
    )
    const lossyRefs = new Set(nodes.filter((node) => node.valueExact === false).map((node) => node.ref))
    const lines = availableLines
      .filter((line) => returnedRefs.has(controlLineRef(line)))
      .map((line) =>
        webRefs.has(controlLineRef(line))
          ? `${line} [text input: page route]`
          : line
      )
      .map((line) => lossyRefs.has(controlLineRef(line)) ? `${line} [value is display-only]` : line)
    controlViews.set(key, { observation: state.snapshot_id, lines })
    rememberControlRefs(request.target, state.snapshot_id, lines)
    for (const ref of webRefs) {
      if (!ref) continue
      const remembered = controlRefs.get(ref)
      if (remembered) remembered.webText = true
    }
    controlUncertain.delete(key)
    return ControlObservationSchema.parse({
      target: request.target,
      observation: state.snapshot_id,
      scope,
      nodes,
      lines,
      coverage: {
        complete:
          state.elements_complete === true &&
          scoped.length <= request.max &&
          !request.query &&
          !request.interactive,
        omitted: z.number().safeParse(state.total_element_count).success
          ? Math.max(
              0,
              z.number().parse(state.total_element_count) -
                state.elements.length +
                Math.max(0, scoped.length - nodes.length)
            )
          : null,
        textComplete: state.truncated !== true,
      },
    })
  }
  const dispatchControlOperation = async (
    target: ControlTarget | undefined,
    operation: z.infer<typeof ControlDispatchRequestSchema>["operation"],
    signal: AbortSignal
  ): Promise<z.infer<typeof z.json>> => {
    if (operation.kind === "command") {
      const action = operation.language === "shell" ? "shell" : "script"
      const args: ComputerArguments =
        operation.language === "shell"
          ? { command: operation.source }
          : { language: operation.language, source: operation.source }
      if (operation.language === "shell" && operation.cwd)
        args.cwd = operation.cwd
      return z.json().parse(await makoAction(action, args, signal))
    }
    if (!target) throw new Error("This control operation requires a target")
    if (target.kind === "page") {
      if (!browserCall)
        throw new Error("Page control is unavailable outside a Mako task")
      const handle = pageTarget(target)
      if (operation.kind === "set-text")
        return browserCall(
          BrowserCommandSchema.parse({
            action: "type",
            target: handle,
            ref: operation.ref,
            text: operation.text,
            clear: true,
          }),
          signal
        )
      if (operation.kind === "activate")
        return browserCall(
          BrowserCommandSchema.parse({
            action: "click",
            target: handle,
            at: { ref: operation.ref },
          }),
          signal
        )
      if (operation.kind === "press-key")
        return browserCall(
          BrowserCommandSchema.parse({
            action: "press",
            target: handle,
            key: operation.key,
            modifiers: operation.modifiers.map((modifier) => {
              const lower = modifier.toLowerCase()
              if (lower === "cmd" || lower === "meta") return "Meta"
              if (lower === "ctrl" || lower === "control") return "Control"
              if (lower === "alt" || lower === "option") return "Alt"
              if (lower === "shift") return "Shift"
              throw new Error(`Unknown key modifier "${modifier}"`)
            }),
            ref: operation.ref,
          }),
          signal
        )
      if (operation.kind === "pointer")
        return browserCall(
          BrowserCommandSchema.parse({
            action: "click",
            target: handle,
            at: operation.at,
            button: operation.button,
            count: operation.count,
          }),
          signal
        )
      if (operation.kind === "scroll")
        return browserCall(
          BrowserCommandSchema.parse({
            action: "scroll",
            target: handle,
            at: operation.at,
            deltaX: operation.deltaX,
            deltaY: operation.deltaY,
          }),
          signal
        )
      return browserCall(
        BrowserCommandSchema.parse({
          action: "selectOption",
          target: handle,
          ref: operation.ref,
          value: operation.value,
          label: operation.label,
        }),
        signal
      )
    }
    if (
      operation.kind === "pointer" &&
      (operation.button === "middle" ||
        operation.count === 3 ||
        (operation.button === "right" && operation.count !== 1))
    )
      throw new Error(
        "This native pointer combination is unsupported; nothing was dispatched"
      )
    const base = { pid: target.pid, window_id: target.window_id }
    if (operation.kind === "set-text")
      return controlData(
        await invokeTool(
          "set_value",
          { ...base, element_token: operation.ref, value: operation.text },
          signal
        )
      )
    if (operation.kind === "activate")
      return controlData(
        await invokeTool(
          "click",
          { ...base, element_token: operation.ref },
          signal
        )
      )
    if (operation.kind === "press-key") {
      const args: ComputerArguments = { ...base }
      if (operation.modifiers.length > 0)
        args.keys = [...operation.modifiers, operation.key]
      else {
        args.key = operation.key
        if (operation.ref) args.element_token = operation.ref
      }
      const action = operation.modifiers.length > 0 ? "hotkey" : "press_key"
      return controlData(await invokeTool(action, args, signal))
    }
    if (operation.kind === "pointer") {
      const args =
        "ref" in operation.at
          ? { ...base, element_token: operation.at.ref }
          : { ...base, x: operation.at.x, y: operation.at.y }
      const action =
        operation.button === "right"
          ? "right_click"
          : operation.count === 2
            ? "double_click"
            : "click"
      return controlData(await invokeTool(action, args, signal))
    }
    if (operation.kind === "scroll") {
      const args: ComputerArguments = {
        ...base,
        delta_x: operation.deltaX,
        delta_y: operation.deltaY,
      }
      if (operation.at && "ref" in operation.at)
        args.element_token = operation.at.ref
      else if (operation.at) {
        args.x = operation.at.x
        args.y = operation.at.y
      }
      return controlData(await invokeTool("scroll", args, signal))
    }
    const value = z.string().parse(operation.value ?? operation.label)
    return controlData(
      await invokeTool(
        "set_value",
        {
          ...base,
          element_token: operation.ref,
          value,
        },
        signal
      )
    )
  }
  const watchNativeTopology = async (
    target: WindowControlTarget,
    actionId: string,
    baseline: Set<number>
  ) => {
    const signal = AbortSignal.timeout(1_200)
    let known = baseline
    try {
      while (!signal.aborted) {
        await wait(100, signal)
        const rows = await nativeWindows(target.pid, signal)
        const next = new Set(
          rows.flatMap((row) =>
            row.window_id === undefined ? [] : [row.window_id]
          )
        )
        const opened = [...next].filter((id) => !known.has(id))
        const closedWindows = [...known].filter((id) => !next.has(id))
        if (opened.length > 0 || closedWindows.length > 0)
          pushControlEvent(target, "topology", {
            action_id: actionId,
            opened,
            closed: closedWindows,
          })
        known = next
      }
    } catch {
      // The guard is advisory after a completed action; its terminal event
      // tells callers to reobserve before using an old ref.
    } finally {
      pushControlEvent(target, "guard-settled", { action_id: actionId })
    }
  }
  const operationRefs = (
    operation: z.infer<typeof ControlDispatchRequestSchema>["operation"]
  ): string[] => {
    if (
      operation.kind === "set-text" ||
      operation.kind === "activate" ||
      operation.kind === "select-option"
    )
      return [operation.ref]
    if (operation.kind === "press-key")
      return operation.ref ? [operation.ref] : []
    if (
      (operation.kind === "pointer" || operation.kind === "scroll") &&
      operation.at &&
      "ref" in operation.at
    )
      return [operation.at.ref]
    return []
  }
  const validateControlRefs = (
    target: ControlTarget | undefined,
    operation: z.infer<typeof ControlDispatchRequestSchema>["operation"]
  ) => {
    if (
      (operation.kind === "pointer" || operation.kind === "scroll") &&
      operation.at &&
      "x" in operation.at
    ) {
      if (
        !target ||
        !operation.at.view ||
        controlVisuals.get(controlTargetKey(target)) !== operation.at.view
      )
        throw new ControlFault(
          "stale-view",
          "Coordinates require this target's latest screenshot view token; capture it again. Nothing was dispatched.",
          "not-dispatched"
        )
    }
    const refs = operationRefs(operation)
    if (refs.length === 0) return
    if (!target) throw new Error("A ref requires an exact control target")
    const key = controlTargetKey(target)
    const current = controlViews.get(key)
    for (const ref of refs) {
      const binding = controlRefs.get(ref)
      if (
        !binding ||
        binding.target !== key ||
        binding.observation !== current?.observation
      )
        throw new ControlFault(
          "stale-reference",
          `Ref "${ref}" is not from this target's latest observation. Observe the exact target again; nothing was dispatched.`,
          "not-dispatched"
        )
    }
  }
  const controlDispatch = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlDispatchRequestSchema.parse(raw)
    validateControlRefs(request.target, request.operation)
    if (
      request.target?.kind === "window" &&
      request.operation.kind === "set-text" &&
      controlRefs.get(request.operation.ref)?.webText
    ) {
      const browser = pageRoutes.get(request.target.pid)?.browser
      const recovery = browser
        ? `Discover the exact page with control.tabs(${JSON.stringify(browser)}), claim it, observe and fill its own ref.`
        : "Use a connected page handle for this web content; no page connection is registered for this app."
      throw new ControlFault(
        "page-input-required",
        `This text field is inside web content. Native AX value writes are not reliable here. ${recovery} Nothing was dispatched.`,
        "not-dispatched"
      )
    }
    const capabilities =
      request.target?.kind === "window"
        ? request.operation.kind === "set-text" ||
          request.operation.kind === "activate" ||
          request.operation.kind === "select-option"
          ? windowCapabilities({
              target: request.target,
              documentWindows: 1,
              onScreen: null,
              pageBrowser:
                pageRoutes.get(request.target.pid)?.browser ?? undefined,
            })
          : await nativeCapabilities(request.target, signal)
        : undefined
    const plan = planControlOperation(
      request.target,
      request.operation,
      capabilities
    )
    if (plan.status !== "selected")
      throw new ControlFault(
        "unsupported",
        `Nothing was dispatched: ${JSON.stringify(plan)}`,
        "not-dispatched"
      )
    const key = request.target ? controlTargetKey(request.target) : undefined
    if (key && controlUncertain.has(key))
      throw new ControlFault(
        "observation-required",
        "Previous action outcome unknown. Observe this exact target before another mutation; nothing was dispatched.",
        "not-dispatched"
      )
    validateControlRefs(request.target, request.operation)
    if (key) invalidateControlTarget(key)
    let result: JsonValue
    try {
      result = z
        .json()
        .parse(
          await dispatchControlOperation(
            request.target,
            request.operation,
            signal
          )
        )
    } catch (error) {
      const detail = controlFaultData(error)
      if (key && (!detail || detail.outcome === "unknown"))
        controlUncertain.add(key)
      throw new ControlFault(
        detail?.code ?? "dispatch-failed",
        error instanceof Error ? error.message : "Control dispatch failed",
        detail?.outcome ?? "unknown"
      )
    }
    const evidence = actionReceipt(
      request.operation.kind,
      {},
      undefined,
      result
    )
    const actionId = randomUUID()
    let guard: ComputerArguments = { status: "settled" }
    if (
      asyncNativeGuard &&
      request.target?.kind === "window" &&
      plan.topology !== "none"
    ) {
      const rows = await nativeWindows(request.target.pid, signal)
      const baseline = new Set(
        rows.flatMap((row) =>
          row.window_id === undefined ? [] : [row.window_id]
        )
      )
      guard = {
        status: "watching",
        action_id: actionId,
        until: Date.now() + 1_200,
      }
      void watchNativeTopology(request.target, actionId, baseline)
    }
    const receipt: ComputerArguments = {
      status: "dispatched",
      actionId,
      route: plan.route,
      delivery: evidence.delivery,
      verification: "not-requested",
      guard,
    }
    if (request.operation.kind === "command") receipt.result = result
    return receipt
  }
  const controlEventValue = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlEventsRequestSchema.parse(raw)
    if (request.target.kind === "page") {
      if (!browserCall)
        throw new Error("Page control is unavailable outside a Mako task")
      return browserCall(
        BrowserCommandSchema.parse({
          action: "events",
          target: pageTarget(request.target),
          after: request.after,
          limit: request.limit,
        }),
        signal
      )
    }
    const key = controlTargetKey(request.target)
    const events = controlEvents
      .filter((event) => event.target === key && event.cursor > request.after)
      .slice(0, request.limit)
    return {
      events,
      next:
        events.at(-1)?.cursor ?? Math.max(request.after, controlEventCursor),
    }
  }
  const controlRaw = async (
    backend: "native" | "page",
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlRawRequestSchema.parse({ ...raw, backend })
    if (backend === "native" && controlUncertain.size > 0)
      throw new ControlFault(
        "observation-required",
        "An action outcome is unknown. Observe or capture the affected target before raw native calls; nothing was dispatched.",
        "not-dispatched"
      )
    // Raw calls have no unified snapshot contract. Retire all affected refs.
    for (const key of controlViews.keys()) invalidateControlTarget(key)
    controlVisuals.clear()
    if (backend === "native") {
      if (request.name === "launch_app" && request.args.page_route === true) {
        const args = { ...request.args }
        delete args.page_route
        return launchWithPageRoute(args, signal)
      }
      return controlData(await invokeTool(request.name, request.args, signal))
    }
    if (!browserCall)
      throw new Error("Page control is unavailable outside a Mako task")
    return browserCall(
      BrowserCommandSchema.parse({ ...request.args, action: request.name }),
      signal
    )
  }
  const rememberVisual = (key: string, view: string) => {
    controlVisuals.set(key, view)
    while (controlVisuals.size > 64)
      controlVisuals.delete(controlVisuals.keys().next().value!)
  }
  const controlCapture = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = z
      .object({
        target: ControlTargetSchema,
        options: computerArgumentsSchema.default({}),
      })
      .strict()
      .parse(raw)
    const key = controlTargetKey(request.target)
    invalidateControlTarget(key)
    if (request.target.kind === "page") {
      if (!browserCall)
        throw new Error("Page control is unavailable outside a Mako task")
      const value = z.record(z.string(), z.json()).parse(
        await browserCall(
          BrowserCommandSchema.parse({
            ...request.options,
            action: "screenshot",
            target: pageTarget(request.target),
          }),
          signal
        )
      )
      const view = z.string().safeParse(value.view)
      if (view.success) rememberVisual(key, view.data)
      controlUncertain.delete(key)
      return value
    }
    const value = controlData(
      await invokeTool(
        "get_window_state",
        {
          ...request.options,
          pid: request.target.pid,
          window_id: request.target.window_id,
          include_screenshot: true,
        },
        signal
      )
    )
    const view = randomUUID()
    rememberVisual(key, view)
    controlUncertain.delete(key)
    const content = z
      .object({ content: z.array(z.json()).default([]) })
      .parse(value).content
    const image = content
      .map((block) => programImageSchema.safeParse(block))
      .find((result) => result.success)
    const inline = image?.success ? image.data : undefined
    if (inline)
      return { ...inline, ...programImageReceiptSchema.parse(value), view }
    const screenshotPath = z.string().safeParse(value.screenshot_file_path)
    if (screenshotPath.success) {
      const data = await readFile(screenshotPath.data)
      return {
        data: data.toString("base64"),
        mimeType: "image/png",
        ...programImageReceiptSchema.parse(value),
        view,
      }
    }
    throw new Error("The native driver returned no screenshot")
  }
  const CONTROL_ACTIONS = [
    "targets",
    "observe",
    "dispatch",
    "events",
    "capture",
    "native",
    "page",
  ] as const
  const controlHelp = async (
    args: z.infer<typeof controlHelpInputSchema> = {}
  ) => {
    if (args.domain !== undefined)
      return browserProtocolHelp(args.domain, args.method)
    if (args.tool !== undefined) {
      const detail = await help({ tool: args.tool })
      return {
        ...detail,
        signature: `control.native(${JSON.stringify(args.tool)}, args)`,
        notes: [
          "Raw native call; unified refs expire. Observe before high-level input. Host target, session and foreground checks still apply.",
        ],
      }
    }
    return {
      version: 2,
      execution: `Start ${execTool} with {"source":"return await control.browsers()"}. A running receipt returns a numeric cell; collect it through the same tool with {"cell":1}. Copy the receipt's actual ID. Supply exactly one field; cell never contains source code.`,
      discovery:
        "control.apps() -> {apps:[...]}; control.windows(pid) -> {kind:'windows',pid,windows:[...]}; control.browsers() -> {kind:'browsers',available,browsers:[{id,name,preferred,transport,guidance?,lastInterruption?,connection,...}]}; control.tabs(browser) -> {kind:'pages',browser,pages:[{targetId,title,url,selectable,...}]}. These methods return objects, not arrays.",
      handles:
        "control.app({pid}).windows(), control.app({pid}).window(window_id), control.window({pid,window_id}), control.tab({kind:'page',browser,tab,generation,lease}), await control.openTab({browser?,url?,background?,disposition?,lifetime?,context?}), await control.claimTab({browser,tab,takeover?}). Store handles in state across cells. App windows are selected explicitly; no implicit first window.",
      target:
        "await handle.observe({within?:[{role,name}],match?:{role,name},query?,interactive?,max?}); handle.setValue(ref,value), click(ref|{x,y,view},{button?,count?}), activate(ref), pressKey(key,{modifiers?,ref?}), scroll({deltaX?,deltaY?,at?}), selectOption(ref,{value}|{label}), events({after?,limit?}). Mutations return {status:'dispatched',actionId,route,delivery,verification:'not-requested',guard}; refs expire after mutation or observation.",
      observations:
        "Observation has nodes, lines, coverage, get({role,name,within?}) for exactly one observed node, select({text?,roles?,states?,includeAncestors?,max?}), diff(previous). Returning it emits compact lines once. Return .nodes only when full structured output is needed. No automatic emission or screenshots. Native web text fields report inputRoute:page and pageBrowser when connected; claim and observe that exact page before typing. No app-specific instructions are assumed.",
      assertions:
        "await handle.expect({role,name,within?,value?,states?,absent?},{timeoutMs?,everyMs?}) polls fresh structured evidence without replaying actions. Exact value equality; duplicates fail. Absent requires complete coverage. Positive evidence is scoped to observed nodes, not proof of global uniqueness. Check coverage when the UI is partial.",
      page: "tab.navigate(url,{waitUntil?,timeoutMs?}), screenshot(options?), upload(ref,files), close(), release(), cdp(method,params?). tab.raw(name,args?) is the explicit page escape hatch; call help({domain,method}) for pinned CDP schemas. Profile/task/background defaults; isolated contexts require direct CDP.",
      native:
        "window.screenshot({screenshot_out_file?}) returns a view token; coordinates require {x,y,view}, window.raw(name,args?), control.native(name,args?) for driver lifecycle/capabilities. Same host validation and foreground policy. Raw calls invalidate unified refs; observe before returning to high-level input.",
      command:
        "control.command({language:'shell'|'applescript'|'jxa',source,cwd?}) returns dispatch evidence plus result (stdout,stderr,exit_code,timed_out,truncated). Inspect exit_code; dispatch is not command success.",
      output:
        "return value or console.log(value); emitImage(await handle.screenshot()) emits images through existing budgets. state retains handles across cells, checkpoint/recall retain bounded JSON facts; cancellation resets the worker. Await every action. Old cell callbacks cannot use a newer cell.",
    }
  }
  let controlTail: Promise<unknown> = Promise.resolve()
  const runControl = async (
    command: ComputerArguments,
    signal: AbortSignal
  ): Promise<JsonValue> => {
    const action = z.enum(CONTROL_ACTIONS).parse(command.action)
    const args = { ...command }
    delete args.action
    const invoke = async () => {
      signal.throwIfAborted()
      if (action === "targets") return controlTargets(args, signal)
      if (action === "observe") return controlObserve(args, signal)
      if (action === "dispatch") return controlDispatch(args, signal)
      if (action === "events") return controlEventValue(args, signal)
      if (action === "capture") return controlCapture(args, signal)
      return controlRaw(action, args, signal)
    }
    // Explicit concurrent CDP is needed to release a paused request or dialog.
    const concurrent =
      action === "page" &&
      z
        .object({ args: z.object({ concurrent: z.literal(true) }) })
        .safeParse(args).success
    const running = concurrent ? invoke() : controlTail.then(invoke, invoke)
    if (!concurrent) controlTail = running.catch(() => {})
    return z.json().parse(await running)
  }
  const program = async () => {
    const available = unified ? [] : await tools()
    runtime ??= new ControlProgramRuntime({
      namespace,
      actions: unified
        ? [...CONTROL_ACTIONS]
        : [
            "status",
            "help",
            ...MAKO_ACTIONS.map((tool) => tool.name),
            ...available.map((tool) => tool.name),
          ],
      extra: !unified && browserCall ? { browser: BROWSER_ACTIONS } : {},
      artifacts,
      call: async (command, signal, namespace) => {
        if (unified) return runControl(command, signal)
        if (namespace === "browser") {
          if (!browserCall)
            throw new Error(
              "The browser object needs a Mako task's browser control; this server has none."
            )
          const parsed = BrowserCommandSchema.safeParse(command)
          if (!parsed.success)
            throw new Error(
              `Invalid arguments for browser.${String(command.action)}. ${z.prettifyError(parsed.error).replace(/\s+/g, " ").trim()} Nothing was dispatched.`
            )
          return browserCall(parsed.data, signal)
        }
        const action = z.string().parse(command.action)
        const args = { ...command }
        delete args.action
        if (action === "status") return status()
        if (action === "help")
          return z
            .json()
            .parse(await help(COMPUTER_TOOL_INPUTS.help.parse(args)))
        if (MAKO_ACTIONS.some((tool) => tool.name === action))
          return z
            .json()
            .parse(
              await makoAction(
                action,
                computerArgumentsSchema.parse(args),
                signal
              )
            )
        if (action === "launch_app" && args.page_route === true) {
          delete args.page_route
          return z
            .json()
            .parse(
              await launchWithPageRoute(
                computerArgumentsSchema.parse(args),
                signal
              )
            )
        }
        const result = await invokeTool(
          action,
          computerArgumentsSchema.parse(args),
          signal
        )
        const refused = toolResultError(result)
        if (refused !== undefined) throw new Error(refused)
        return toolResultData(result)
      },
      image: computerProgramImage,
      fault: (detail) =>
        new ControlFault(detail.code, detail.message, detail.outcome),
    })
    return runtime
  }
  class ComputerServer extends Server {
    override async close(): Promise<void> {
      closed = true
      observations.close()
      await super.close()
      await runtime?.close()
      await browserCall?.close?.()
      await closePageRoutes()
      await client?.close()
    }
  }
  const statusTool = `${toolPrefix}_status`
  const helpTool = `${toolPrefix}_help`
  const execTool = `${toolPrefix}_exec`
  const server = new ComputerServer(
    {
      name: unified ? "mako-control" : "mako-driver-test-runtime",
      version: "4.0.0",
    },
    {
      capabilities: { tools: {} },
      instructions: unified ? controlInstructions : instructions,
    }
  )
  server.onclose = () => {
    closed = true
    observations.close()
    void runtime?.close()
    void browserCall?.close?.()
    void closePageRoutes()
    void client?.close()
  }
  const reference = async () => {
    try {
      return renderReference((await tools()).map(asDriverTool))
    } catch (error) {
      return `Driver actions: unavailable (${error instanceof Error ? error.message : String(error)}). mako_computer_status reports when the driver is attached.`
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: statusTool,
        description: unified
          ? "Report the routes available to this provider-neutral Mako control client, including page control, native control and the bounded native guard. Does not request OS permission."
          : "Report whether this MCP client is attached to Mako's native computer-control driver, the input routing policy, and where oversized results are written. Does not request OS permission.",
        inputSchema: z.toJSONSchema(COMPUTER_TOOL_INPUTS.status, {
          io: "input",
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: helpTool,
        description: unified
          ? "Reference for Local Control v2 bound handles, explicit observations, assertions and escape hatches. With domain and optional method, returns the pinned CDP schema."
          : "Reference for the computer program API, read from the live driver. With no arguments, lists every computer.<action> signature and the background input ladder. With tool, returns that action's full input and output schema, its description and Mako's notes.",
        inputSchema: z.toJSONSchema(
          unified ? controlHelpInputSchema : COMPUTER_TOOL_INPUTS.help,
          {
            io: "input",
          }
        ),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: execTool,
        description: unified
          ? `Run Local Control v2 with {"source":"return await control.browsers()"}. To collect a running program, copy its numeric cell into {"cell":1}; supply exactly one field. Use bound window/tab handles, explicit observe/expect, state for cross-cell handles, return/console.log for text and emitImage for screenshots. Read mako_control_help once for API signatures. ${PROGRAM_TIME_LIMIT_MS / 1000}-second hard limit; output past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB spills whole to artifacts. No actions are replayed.`
          : `Run or resume a computer control program: pass {source} with trusted async JavaScript, or {cell} when a program yields after ten seconds and continues. Read a window with view(), take and verify a step with act(), write a field with fill(), press Enter with submit(), select a proven route with route(), and guard chained steps with expect() and until(); state and bounded checkpoint/recall task memory survive cells. Await every action and return only what you need to decide. Nothing fronts the user's application without foreground: true on the call. Results are never truncated: a value past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB is written to a file and described. ${PROGRAM_TIME_LIMIT_MS / 1000}-second hard limit; every action keeps Mako's session, snapshot, path, foreground and preview checks.

checkpoint({objective?, location?, remember?: {key: value}, completed?: string[], pending?: string[]}) stores bounded task memory; remember is an object, not prose. recall() reads it.

${await reference()}`,
        inputSchema: ControlProgramInputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let dispatched = false
    try {
      switch (request.params.name) {
        case statusTool: {
          COMPUTER_TOOL_INPUTS.status.parse(request.params.arguments ?? {})
          return {
            content: [{ type: "text", text: JSON.stringify(await status()) }],
          }
        }
        case helpTool: {
          const rawArgs = request.params.arguments ?? {}
          const value = unified
            ? await controlHelp(controlHelpInputSchema.parse(rawArgs))
            : await help(COMPUTER_TOOL_INPUTS.help.parse(rawArgs))
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
          }
        }
        case execTool: {
          const input = COMPUTER_TOOL_INPUTS.exec.parse(
            request.params.arguments
          )
          const active = await program()
          dispatched = true
          return {
            content:
              input.source !== undefined
                ? await active.run(input.source, extra.signal)
                : await active.wait(z.number().parse(input.cell), extra.signal),
          }
        }
        default:
          throw new Error(
            `Unknown tool ${request.params.name}. Control is ${statusTool}, ${helpTool} and ${execTool}; every action runs inside ${execTool}.`
          )
      }
    } catch (error) {
      observations.submit({
        operation: request.params.name.replace(
          /^mako_(?:computer|control)_/,
          ""
        ),
        target: "Selected application",
        status: "error",
      })
      const detail = {
        code: controlFaultData(error)?.code ?? (dispatched ? "computer-control-error" : "invalid-request"),
        outcome: controlFaultData(error)?.outcome ?? (dispatched ? "unknown" : "not-dispatched"),
        message:
          error instanceof z.ZodError
            ? `Invalid arguments for ${request.params.name}. ${z.prettifyError(error).replace(/\s+/g, " ").trim()}`
            : error instanceof Error
              ? error.message
              : "Computer operation failed",
        recovery: !dispatched
          ? request.params.name === execTool
            ? `No program was started or resumed by this call. To start, use {"source":"<async JavaScript>"}; to collect, copy the numeric cell from the running receipt, for example {"cell":1}. Correct the arguments; do not resubmit a running program's source.`
            : "Correct the tool arguments and call again; no control action was dispatched."
          : controlFaultData(error)?.code === "cell-pending" || controlFaultData(error)?.code === "cell-not-found"
            ? "Follow the cell instructions in the message. Do not start another program to recover a pending result."
            : "Read the exact target again before deciding whether to repeat an action.",
      }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(detail) }],
        structuredContent: detail,
      }
    }
  })
  return server
}

export async function startComputerToolsServer(): Promise<void> {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      driver: { type: "string" },
      "driver-test": { type: "boolean", default: false },
    },
  })
  const backend =
    values.socket && values.driver
      ? {
          command: values.driver,
          args: ["mcp", "--embedded", "--socket", values.socket],
          // The proxy's own telemetry, off like the daemon's (cua-embedded.ts).
          env: {
            ...getDefaultEnvironment(),
            CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
          },
        }
      : undefined
  const transport = z
    .enum(["mcp", "direct-sdk"])
    .default("mcp")
    .parse(process.env.MAKO_CUA_TRANSPORT)
  const connectDriver: ComputerDriverConnector =
    transport === "mcp"
      ? connectMcpComputerDriver
      : async (process) => {
          const { connectCuaSdkComputerDriver } =
            await import("./cua-sdk-client.js")
          return connectCuaSdkComputerDriver(process)
        }
  const server = createComputerToolsServer(backend, undefined, connectDriver, {
    surface: values["driver-test"] ? "driver" : "control",
  })
  const close = () => {
    void server.close()
  }
  process.stdin.once("end", close)
  process.once("SIGTERM", close)
  process.once("SIGINT", close)
  await server.connect(new StdioServerTransport())
}
if (isMainModule(import.meta.url))
  void startComputerToolsServer().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
