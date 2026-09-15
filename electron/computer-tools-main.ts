import { AppshotTargetSchema } from "./contracts/appshots.js"
import { verifyForegroundInput } from "./computer-input-target.js"
import { ComputerObservationClient } from "./computer-observation-client.js"
import { resolveDriverPaths } from "./computer-paths.js"
import {
  ControlProgramRuntime,
  INLINE_IMAGE_COUNT,
  INLINE_TEXT_BUDGET,
  PROGRAM_TIME_LIMIT_MS,
  controlArtifactsDirectory,
  type ControlProgramOutput,
} from "@mako/control/program"
import {
  BACKGROUND_INPUT_LADDER,
  KEYBOARD_TOOLS,
  KEY_ROUTE_ADVICE,
  MAKO_ACTIONS,
  carryToken,
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
  withoutEscalationNudge,
  withoutMenuBar,
  type DriverTool,
  type SnapshotIndex,
} from "@mako/control/computer"
import { driverSchemaValidator } from "./driver-schema.js"
import { BROWSER_ACTIONS } from "./browser-tools-runtime.js"
import { browserControlClient } from "./browser-control-client.js"
import { BrowserCommandSchema } from "./contracts/browser-control.js"
import { execFile } from "node:child_process"
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js"
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

How to work: windows(pid) to pick the document window; view(target) to read it as one line per element; act('click', {element_token}) for a step whose result you must see, since what changed comes back with it (act reads the window while the driver's own verification wait runs, so a step costs one wait, not two); fill(element_token, text) to write a field without a keyboard and read it back; submit(element_token) for Enter without a keyboard; routes(target) to learn which routes reach a window before spending a round trip on a refusal; chain steps in one program when each follows from the last without your judgement, with expect() guarding the assumptions and until() waiting for the screen; then answer. When the intent has a command, script({language, source}) runs AppleScript or JXA and shell({command}) runs a command line, both without touching focus; a Finder listing is one line there and eleven windows of accessibility on the GUI route. A window is about 800 tokens as view() lines and about 12,000 as get_window_state JSON: read with view, and use get_window_state when you need frames, actions or the screenshot. \`state\` persists between programs of this MCP client (the helpers keep state.target and state.last there); \`console.log(value)\` adds a text block; \`emitImage(result)\` adds the image a result carries (get_window_state with its screenshot, zoom) with its snapshot receipt; \`artifacts.save(name, value)\` writes a value or image to a file and returns its path. Your session identity is supplied automatically and cannot collide with another task; never pass session.

Grounding: an element_token alone addresses an action, because Mako remembers which pid and window produced each snapshot; every read (view, act, until, get_window_state) takes a new snapshot; a token from an earlier snapshot of the same window is carried to the same control (same role, label and position among its likes) in the newest one, and the result says so in carried_token, so fill(field) then act('click', {element_token: button}) from one view works; only a control that is gone is refused as stale. Screenshot coordinates are window-local pixels of that window's latest capture (element frames are screen points: subtract window_bounds and multiply by screenshot_scale); for a small target zoom a region and pass from_zoom:true with coordinates read off the zoom image. Reobserve after acting: transport success is not proof the UI changed, and a timeout or cancellation does not prove an action did not run. A stale token or a missing window means rediscover, never another window.

Background input, in order (details in mako_computer_help().routes): 1 accessibility — fill, set_value and element_token clicks (action press/pick/confirm/open), for anything an observed element exposes; this is how a backgrounded Electron or Chromium field is written, since set_value replaces text where a keyboard would select-all and retype. 2 page route — launch_app({bundle_id, page_route: true}) starts an Electron or Chromium app in the background with a private DevTools port and registers it as browser 'app:<bundle_id>'; the browser object is available in every computer program (browser.tabs({browser}), browser.select, browser.click, browser.type, browser.press, browser.observe, browser.screenshot), with keyboard, pointer, DOM reads and screenshots that never touch focus. 3 command — script and shell. 4 window pointer with x,y. 5 pid keyboard (type_text, press_key, hotkey): native Cocoa fields only and never a Cmd chord — Mako refuses a background Cmd chord before it is posted because an application that is not frontmost does not dispatch menu key equivalents (force: true posts it anyway); a Chromium or Electron renderer that is not frontmost drops every posted key; the driver cannot read keys back, so send them through act() and let the delta say whether they landed, and treat mako_routes.status 'unconfirmed' as a reason to read, not to retry. 6 invoke_menu for a menu item or its shortcut: the driver fronts the application for the call and restores the previous frontmost app itself, so it requires foreground: true and reports fronted.ms. 7 delivery_mode:'foreground' with foreground: true: Mako verifies that the exact application and window are already frontmost and refuses otherwise; bring_to_front requires foreground: true too. Mako never fronts on its own, and a result never asks you to: the user is working in another application. Electron and Chromium windows ignore background scrolling on macOS; use their page route. Do not repeat text based on delivered_chars alone: the driver can report zero when the field received everything.

Results: every action resolves to the driver's structured data, and a refused action throws with the driver's message (Mako's own refusals — a fronting call without foreground: true, a background Cmd chord — throw before the driver is asked); images ride on result.content. A call that fronted carries fronted: {pid, ms}, and mako_computer_status counts them for the task. list_windows rows carry kind: document, helper or unknown, and helper strips are not windows. get_window_state omits the application's menu bar and the duplicate tree_markdown (include_menu_bar:true and include_markdown:true restore them) and defaults max_elements to ${DEFAULT_MAX_ELEMENTS}. A returned or logged value at or past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB, and every image after the ${INLINE_IMAGE_COUNT}th in one program, is written whole to a file and the result carries a receipt with the path, size, hash and an outline of the value's shape; nothing is cut. Programs stop after ${PROGRAM_TIME_LIMIT_MS / 1000} seconds; on timeout, cancellation or an error the worker and \`state\` reset while the driver session, snapshots and Mako's checks remain. Scripts are trusted local code, not an OS sandbox; every action still passes Mako's session, snapshot, path, foreground and preview checks.

Output and input file paths (screenshot_out_file, output_dir, destination_root, files) may be absolute, ~-rooted or relative to the working directory; Mako resolves symlinked parents such as /tmp before the driver inspects them. macOS permissions, Chrome debugging consent and provider tool approval are distinct.`
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
  exec: z
    .object({
      source: z
        .string()
        .min(1)
        .max(100_000)
        .describe(
          "Async JavaScript body. Call computer.<action>({...}) and await every call; return the value you want to see."
        ),
    })
    .strict(),
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
const computerArgumentsSchema = z.record(z.string(), z.json())
type ComputerArguments = z.infer<typeof computerArgumentsSchema>
const programImageSchema = z.object({
  data: z.string().max(24 * 1024 * 1024),
  mimeType: z.enum(["image/png", "image/jpeg"]),
})
const programImageReceiptSchema = z.object({
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

export interface ComputerBackend {
  command: string
  args: string[]
  env?: Record<string, string>
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
  if (direct.success) return [{ type: "image", ...direct.data }]
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
  windows: z.array(z.looseObject({ kind: z.string().optional() })),
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

export interface PageRoute {
  browser: string | null
  endpoint: string
  bundle_id: string
  name: string
  [key: string]: string | null
}

export function createComputerToolsServer(
  backend?: ComputerBackend,
  taskId = process.env.MAKO_TASK_ID ?? randomUUID()
): Server {
  const observations = new ComputerObservationClient()
  const artifacts = controlArtifactsDirectory("computer", taskId)
  let client = new Client({ name: "mako-computer-use", version: "3.0.0" })
  let closed = false
  let starting: Promise<Tool[]> | undefined
  let runtime: ControlProgramRuntime | undefined
  // The driver binds a session to the MCP transport that created it, so a
  // reconnect must mint a fresh id; the task id keeps it distinct from others.
  let session = `mako-${taskId}-${randomUUID().slice(0, 8)}`
  // The driver wants the pid and window that produced a snapshot, and
  // honours tokens from a window's newest snapshot only; remember each
  // snapshot's identity and element addresses, and the newest per window,
  // so a token alone is enough and one read from an earlier snapshot is
  // carried to the same control rather than refused as stale.
  const snapshots = new Map<string, SnapshotIndex>()
  const newestSnapshot = new Map<string, string>()
  // Every call that took the screen, counted for the task; and the page
  // routes of the Electron or Chromium applications this task launched.
  let frontingEvents = 0
  const pageRoutes = new Map<number, PageRoute>()
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
    if (!client) return
    cursorQuietedFor = session
    for (const [name, rest] of [
      ["set_agent_cursor_motion", QUIET_CURSOR_MOTION],
      ["set_agent_cursor_enabled", { enabled: false }],
    ] as const) {
      try {
        await client.callTool(
          { name, arguments: { session, ...rest } },
          undefined,
          { signal, timeout: 10_000 }
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
    process.env.MAKO_CONTROL_URL && process.env.MAKO_CONTROL_TOKEN
      ? browserControlClient()
      : undefined
  const tools = () => {
    starting ??= (async () => {
      if (closed) throw new Error("Computer control connection is closed")
      if (!backend) return []
      const connection = new Client(
        { name: "mako-computer-use", version: "3.0.0" },
        { jsonSchemaValidator: driverSchemaValidator() }
      )
      client = connection
      session = `mako-${taskId}-${randomUUID().slice(0, 8)}`
      snapshots.clear()
      connection.onclose = () => {
        if (client !== connection) return
        starting = undefined
        void runtime?.close()
        runtime = undefined
      }
      const transport = new StdioClientTransport({ ...backend, stderr: "pipe" })
      try {
        await connection.connect(transport)
        const result = await connection.listTools()
        return result.tools
      } catch (error) {
        await connection.close()
        await transport.close()
        throw error
      }
    })().catch((error) => {
      starting = undefined
      throw error
    })
    return starting
  }
  const status = async (): Promise<ComputerArguments> => ({
    available: Boolean(backend),
    driverTools: (await tools()).length,
    program: "mako_computer_exec",
    helpers: [
      "view",
      "act",
      "until",
      "expect",
      "windows",
      "fill",
      "submit",
      "routes",
    ],
    makoActions: MAKO_ACTIONS.map((tool) => tool.name),
    browser: browserCall
      ? "browser.<action> available in programs"
      : "unavailable outside a Mako task",
    agentCursor:
      "quiet for every Mako session: glide_duration_ms 1, no dwell, hidden (the driver's awaited cursor glide cost 1.5 s of every action on a new element and moved on the user's screen); computer.set_agent_cursor_enabled({enabled: true}) shows it",
    help: "mako_computer_help",
    inputRoutes: {
      default: "background",
      order: BACKGROUND_INPUT_LADDER.map((rung) => rung.route),
      foreground: "explicit-preflight",
      preflight: ["foreground-flag", "active-application", "front-window"],
      automaticEscalation: false,
      backgroundCmdChords: "refused before dispatch unless force: true",
    },
    frontingEvents,
    pageRoutes: Object.fromEntries(
      [...pageRoutes].map(([pid, route]) => [String(pid), route])
    ),
    artifacts,
  })
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
        "Every action is computer.<action>({...}) inside mako_computer_exec, beside the helpers view, act, until, expect, windows, fill, submit and routes and the browser object; call help({tool}) for one action's full schema.",
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
    newestSnapshot.set(
      `${snapshot.pid}:${snapshot.window_id}`,
      snapshot.snapshot_id
    )
  }
  const invokeTool = async (
    name: string,
    inputArguments: ComputerArguments,
    signal: AbortSignal
  ) => {
    const available = await tools()
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
    let carried: { given: string; used: string } | undefined
    if (remembered) {
      if (input.properties?.pid && !positiveInteger.safeParse(args.pid).success)
        args.pid = remembered.pid
      if (
        input.properties?.window_id &&
        !positiveInteger.safeParse(args.window_id).success
      )
        args.window_id = remembered.window_id
      // A token from a superseded snapshot of the window goes to the same
      // control in the newest one; a control that is gone stays as given
      // and the driver refuses it by name.
      const newestId = newestSnapshot.get(
        `${remembered.pid}:${remembered.window_id}`
      )
      if (token.success && newestId && newestId !== snapshotId) {
        const newest = snapshots.get(newestId)
        const used = newest
          ? carryToken(token.data, remembered, newest)
          : undefined
        if (used) {
          carried = { given: token.data, used }
          args.element_token = used
        }
      }
    }
    if (args.delivery_mode === "foreground" && input.properties?.pid)
      await verifyForegroundInput(client, args, signal)
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
      await client.callTool({ name: tool.name, arguments: args }, undefined, {
        signal,
        timeout: 60_000,
      })
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
      const noted: StructuredContent = carried
        ? { ...stripped, carried_token: carried }
        : stripped
      if (!fronted) return noted
      const receipt: StructuredContent = { ms: Date.now() - startedAt }
      if (pid !== undefined) receipt.pid = pid
      return { ...noted, fronted: receipt }
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
    const identity = bundleId ?? label
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
        `launch_app could not open ${identity}: ${launch.stderr.trim() || `open exited ${String(launch.exit_code)}`}`
      )
    const endpoint = await awaitDevTools(port, signal)
    if (!endpoint)
      throw new Error(
        `${identity} was launched but no DevTools endpoint answered on 127.0.0.1:${port} within ${PAGE_ROUTE_WAIT_MS / 1000} s: it is not an Electron or Chromium application, or it ignored --remote-debugging-port. The application may be running; list_apps shows it, and the driver's own routes reach it.`
      )
    const pid = await listenerPid(port, signal)
    if (pid === undefined)
      throw new Error(
        `${identity} answers on 127.0.0.1:${port} but no process owns the port; lsof could not read it.`
      )
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
    const taken = [...pageRoutes.values()].some(
      (route) => route.browser === `app:${identity}`
    )
    const browserId = taken ? `app:${identity}:${pid}` : `app:${identity}`
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
      if (oldest !== undefined) pageRoutes.delete(oldest)
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
    if (action === "page_routes")
      return Object.fromEntries(
        [...pageRoutes].map(([pid, route]) => [String(pid), route])
      )
    throw new Error(`Unknown Mako action "${action}"`)
  }
  const program = async () => {
    const available = await tools()
    runtime ??= new ControlProgramRuntime({
      namespace: "computer",
      actions: [
        "status",
        "help",
        ...MAKO_ACTIONS.map((tool) => tool.name),
        ...available.map((tool) => tool.name),
      ],
      extra: browserCall ? { browser: BROWSER_ACTIONS } : {},
      artifacts,
      call: async (command, signal, namespace) => {
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
      fault: (detail) => new Error(detail.message),
    })
    return runtime
  }
  class ComputerServer extends Server {
    override async close(): Promise<void> {
      closed = true
      observations.close()
      await super.close()
      await runtime?.close()
      await client.close()
    }
  }
  const server = new ComputerServer(
    { name: "mako-local-control", version: "3.0.0" },
    { capabilities: { tools: {} }, instructions }
  )
  server.onclose = () => {
    closed = true
    observations.close()
    void runtime?.close()
    void client.close()
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
        name: "mako_computer_status",
        description:
          "Report whether this MCP client is attached to Mako's native computer-control driver, the input routing policy, and where oversized results are written. Does not request OS permission.",
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
        name: "mako_computer_help",
        description:
          "Reference for the computer program API, read from the live driver. With no arguments, lists every computer.<action> signature and the background input ladder. With tool, returns that action's full input and output schema, its description and Mako's notes.",
        inputSchema: z.toJSONSchema(COMPUTER_TOOL_INPUTS.help, {
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
        name: "mako_computer_exec",
        description: `Run a computer control program: trusted async JavaScript. Read a window with view(), take a step and see what changed with act(), write a field with fill(), press Enter with submit(), learn a window's routes with routes(), guard chained steps with expect() and until(), call any driver action as computer.<action>(args), run a command with computer.script or computer.shell, and drive an Electron or Chromium app's pages with the browser object after launch_app({bundle_id, page_route: true}); state persists, console.log adds text, emitImage adds an image, artifacts.save writes a file. Await every call and return only what you need to decide. Nothing fronts the user's application without foreground: true on the call. Results are never truncated: a value past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB is written to a file and described. ${PROGRAM_TIME_LIMIT_MS / 1000}-second limit; every action keeps Mako's session, snapshot, path, foreground and preview checks.

${await reference()}`,
        inputSchema: z.toJSONSchema(COMPUTER_TOOL_INPUTS.exec, { io: "input" }),
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
    try {
      switch (request.params.name) {
        case "mako_computer_status": {
          COMPUTER_TOOL_INPUTS.status.parse(request.params.arguments ?? {})
          return {
            content: [{ type: "text", text: JSON.stringify(await status()) }],
          }
        }
        case "mako_computer_help": {
          const value = await help(
            COMPUTER_TOOL_INPUTS.help.parse(request.params.arguments ?? {})
          )
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
          }
        }
        case "mako_computer_exec": {
          const { source } = COMPUTER_TOOL_INPUTS.exec.parse(
            request.params.arguments
          )
          return {
            content: await (await program()).run(source, extra.signal),
          }
        }
        default:
          throw new Error(
            `Unknown tool ${request.params.name}. Computer control is mako_computer_status, mako_computer_help and mako_computer_exec; every action is a computer.<action> call inside mako_computer_exec.`
          )
      }
    } catch (error) {
      observations.submit({
        operation: request.params.name.replace(/^mako_computer_/, ""),
        target: "Selected application",
        status: "error",
      })
      const detail = {
        code: "computer-control-error",
        message:
          error instanceof z.ZodError
            ? `Invalid arguments for ${request.params.name}. ${z.prettifyError(error).replace(/\s+/g, " ").trim()}`
            : error instanceof Error
              ? error.message
              : "Computer operation failed",
        recovery:
          "Read the exact target again before deciding whether to repeat an action.",
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
    options: { socket: { type: "string" }, driver: { type: "string" } },
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
  const server = createComputerToolsServer(backend)
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
