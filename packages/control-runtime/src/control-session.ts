import { controlReplDocumentation } from "./control-agent-docs.js"
import type { JsonValue } from "./json.js"
import {
  nativeCapture,
  nativeCapturePoint,
  type NativeCaptureGeometry,
} from "./native-capture.js"
import { NativeScreenshotOptionsSchema } from "@mako/control/control"
import { AppshotTargetSchema } from "./contracts/appshots.js"
import { verifyForegroundInput } from "./computer-input-target.js"
import { ComputerObservationClient } from "./computer-observation-client.js"
import { resolveDriverPaths } from "./computer-paths.js"
import {
  ControlProgramRequestSchema,
  ControlProgramRuntime,
  INLINE_IMAGE_COUNT,
  INLINE_TEXT_BUDGET,
  PROGRAM_TIME_LIMIT_MS,
  controlArtifactsDirectory,
  type ControlProgramOutput,
  type ControlProgramExecution,
} from "@mako/control/program"
import {
  actionReceipt,
  ElementSchema,
  BACKGROUND_INPUT_LADDER,
  elementLines,
  nativeRole,
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
  NativeFocusChangeSchema,
  type NativeFocusChange,
  NativeSettlingSchema,
  type NativeSettling,
  ControlDispatchRequestSchema,
  ControlRawRequestSchema,
  ControlEventsRequestSchema,
  ControlObserveRequestSchema,
  ControlTargetSchema,
  ControlFault,
  controlInput,
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
  browserCommandEffect,
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
import { NativeRecordings, nativeRecordingRate } from "./native-recording.js"
import { RecordingOptionsSchema } from "@mako/control/control"
import { randomUUID } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import { type Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

export { BACKGROUND_INPUT_LADDER }

const DEFAULT_MAX_ELEMENTS = 300

const instructions = `Mako computer control is one program tool over a host-owned native driver. the internal driver test executor runs trusted async JavaScript in a local worker; its description carries the whole API, so write the first program from it. Await every call and return only what you need to decide the next step.

How to work: windows(pid) to pick the document window; view(target) to read it as one line per element; act('click', {element_token}, {postcondition: lines => lines.some(...)}) for a step whose intended result must be proved, since the compact delta and a provider-neutral receipt come back together; omit postcondition when a changed/unchanged observation is enough to decide. fill(element_token, text) writes a field without a keyboard and proves it by read-back; submit(element_token) performs Enter without a keyboard; route(intent, target) selects the strongest proven route for exact, text, control, page, pointer, keyboard, menu or visual work, while routes(target) returns the complete capability set. Chain steps in one program when each follows from the last without your judgement, with expect() guarding assumptions and until() waiting for the screen; return when the next action needs model judgement. When the intent has a command, script({language, source}) runs AppleScript or JXA and shell({command}) runs a command line, both without touching focus; a Finder listing is one line there and eleven windows of accessibility on the GUI route. A window is about 800 tokens as view() lines and about 12,000 as get_window_state JSON: read with view, and use get_window_state when you need frames, actions or the screenshot. \`state\` persists between programs of this session (the helpers keep state.target and state.last there); \`console.log(value)\` adds a text block; \`emitImage(result)\` adds the image a result carries (get_window_state with its screenshot, zoom) with its snapshot receipt; \`artifacts.save(name, value)\` writes a value or image to a file and returns its path. Your session identity is supplied automatically and cannot collide with another task; never pass session.

Long tasks: \`checkpoint({objective?, location?, remember?, completed?, pending?})\` keeps the bounded working set a later cell needs and \`recall()\` reads it. Store constraints, discoveries and evidence receipts there; put raw trees, screenshots and long prose in artifacts instead. Grounding: an element_token alone addresses an action, because Mako remembers which pid and window produced each snapshot; every read (view, act, until, get_window_state) takes a new snapshot and invalidates the earlier tokens for that window. Never carry a token by role or label: duplicate or reordered controls can make that target unsafe. fill() returns view, the exact newest lines from its read-back, so take the next token from written.view before another action. Screenshot coordinates are window-local pixels of that window's latest capture (element frames are screen points: subtract window_bounds and multiply by screenshot_scale); for a small target zoom a region and pass from_zoom:true with coordinates read off the zoom image. Reobserve after acting: transport success is not proof the UI changed, and a timeout or cancellation does not prove an action did not run. A stale token or a missing window means rediscover, never another window.

Background input, in order (details in the driver reference routes): 1 accessibility — fill, set_value and element_token clicks (action press/pick/confirm/open), for anything an observed element exposes; this is how a backgrounded Electron or Chromium field is written, since set_value replaces text where a keyboard would select-all and retype. 2 page route — launch_app({bundle_id, page_route: true}) starts an Electron or Chromium app in the background with a private DevTools port and registers it as browser 'app:<bundle_id>'; the browser object is available in every computer program (browser.tabs({browser}), browser.select, browser.click, browser.type, browser.press, browser.observe, browser.screenshot), with keyboard, pointer, DOM reads and screenshots that never touch focus. 3 command — script and shell. 4 window pointer with x,y. 5 pid keyboard (type_text, press_key, hotkey): native Cocoa fields only and never a Cmd chord — Mako refuses a background Cmd chord before it is posted because the installed keyboard path has not passed background Command delivery acceptance (force: true posts it anyway); a Chromium or Electron renderer that is not frontmost drops every posted key; the driver cannot read keys back, so send them through act() and let the delta say whether they landed, and treat mako_routes.status 'unconfirmed' as a reason to read, not to retry. 6 invoke_menu for a menu item or its shortcut: the driver fronts the application for the call and restores the previous frontmost app itself, so it requires foreground: true and reports fronted.ms. 7 delivery_mode:'foreground' with foreground: true: Mako verifies that the exact application and window are already frontmost and refuses otherwise; bring_to_front requires foreground: true too. Mako never fronts on its own, and a result never asks you to: the user is working in another application. Electron and Chromium windows ignore background scrolling on macOS; use their page route. Do not repeat text based on delivered_chars alone: the driver can report zero when the field received everything.

Results: every action resolves to the driver's structured data, and a refused action throws with the driver's message (Mako's own refusals — a fronting call without foreground: true, a background Cmd chord — throw before the driver is asked); images ride on result.content. A call that fronted carries fronted: {pid, ms}, and Session status counts them for the task. list_windows rows carry kind: document, helper or unknown, and helper strips are not windows. get_window_state omits the application's menu bar and the duplicate tree_markdown (include_menu_bar:true and include_markdown:true restore them) and defaults max_elements to ${DEFAULT_MAX_ELEMENTS}. A returned or logged value at or past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB, and every image after the ${INLINE_IMAGE_COUNT}th in one program, is written whole to a file and the result carries a receipt with the path, size, hash and an outline of the value's shape; nothing is cut. Programs stop after ${PROGRAM_TIME_LIMIT_MS / 1000} seconds; on timeout, cancellation or an error the worker and \`state\` reset while the driver session, snapshots and Mako's checks remain. Scripts are trusted local code, not an OS sandbox; every action still passes Mako's session, snapshot, path, foreground and preview checks.

Output and input file paths (screenshot_out_file, output_dir, destination_root, files) may be absolute, ~-rooted or relative to the working directory; Mako resolves symlinked parents such as /tmp before the driver inspects them. macOS permissions, Chrome debugging consent and provider tool approval are distinct.`
const controlInstructions = controlReplDocumentation
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
export const controlHelpInputSchema = z
  .object({
    syntax: z.enum(["script", "repl"]).optional(),
    topic: z
      .enum([
        "discovery",
        "connection",
        "handles",
        "actions",
        "observations",
        "assertions",
        "recording",
        "page",
        "native",
        "output",
        "examples",
      ])
      .optional()
      .describe("Return only the relevant API section."),
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

export interface ControlSessionOptions {
  artifacts?: string
  previewEnvironment?: NodeJS.ProcessEnv
  surface?: "driver" | "control"
  browserCall?: BrowserCall
  /** A standalone job may end its private desktop when a tool request is cancelled. */
  onProgramCancelled?: () => void
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
  total_element_count: z.number().int().nonnegative().optional(),
  menu_bar_elements_omitted: z.number().int().nonnegative().default(0),
})
const pageViewSchema = z.looseObject({
  observation: z.string(),
  lineage: z.string().optional(),
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

export function createControlSession(
  backend?: ComputerBackend,
  taskId = process.env.MAKO_TASK_ID ?? randomUUID(),
  connectDriver: ComputerDriverConnector = connectMcpComputerDriver,
  options: ControlSessionOptions = {}
) {
  const unified = options.surface !== "driver"
  const namespace = unified ? "control" : "computer"
  const observations = new ComputerObservationClient(options.previewEnvironment)
  const nativeRecordings = new NativeRecordings()
  const artifacts = options.artifacts ?? controlArtifactsDirectory(namespace, taskId)
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
  const controlMutations = new Map<string, number>()
  const controlReads = new Map<string, { interrupted: boolean }>()
  const beginControlMutation = (key: string) => {
    invalidateControlTarget(key)
    const read = controlReads.get(key)
    if (read) read.interrupted = true
    controlMutations.set(key, (controlMutations.get(key) ?? 0) + 1)
    return () => {
      const remaining = (controlMutations.get(key) ?? 1) - 1
      if (remaining) controlMutations.set(key, remaining)
      else controlMutations.delete(key)
    }
  }
  // An unscoped native failure can affect a window we have never observed.
  // Exact-window evidence permits that window again; it cannot authorize
  // another unscoped input whose destination the host cannot establish.
  let unscopedNativeUncertain = false
  const nativeReconciled = new Set<string>()
  const uncertainProfiles = new Set<string>()
  const pageReconciled = new Set<string>()
  const profileKey = (target: PageTarget) =>
    JSON.stringify([target.browser, target.generation])
  const controlNeedsObservation = (target: ControlTarget) => {
    const key = controlTargetKey(target)
    return (
      controlUncertain.has(key) ||
      (target.kind === "window" &&
        unscopedNativeUncertain &&
        !nativeReconciled.has(key)) ||
      (target.kind === "page" &&
        uncertainProfiles.has(profileKey(target)) &&
        !pageReconciled.has(key))
    )
  }
  const reconcileControlTarget = (target: ControlTarget) => {
    const key = controlTargetKey(target)
    if (controlReads.get(key)?.interrupted || controlMutations.has(key)) {
      invalidateControlTarget(key)
      controlUncertain.add(key)
      throw new ControlFault(
        "observation-interrupted",
        "This read overlapped a mutation. Observe the exact target again after its pending action completes.",
        "unknown"
      )
    }
    controlUncertain.delete(key)
    if (target.kind === "page" && uncertainProfiles.has(profileKey(target))) {
      pageReconciled.add(key)
      if (pageReconciled.size > 256)
        pageReconciled.delete(pageReconciled.values().next().value!)
    }
    if (target.kind === "window" && unscopedNativeUncertain) {
      nativeReconciled.add(key)
      // Eviction only requires another observation; it never grants input.
      if (nativeReconciled.size > 256)
        nativeReconciled.delete(nativeReconciled.values().next().value!)
    }
  }
  const controlVisuals = new Map<
    string,
    { view: string; native?: NativeCaptureGeometry }
  >()
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
      if (closed) {
        await connection.close()
        throw new Error("Computer control connection closed during startup")
      }
      client = connection
      session = `mako-${taskId}-${randomUUID().slice(0, 8)}`
      snapshots.clear()
      // Driver reconnect invalidates native evidence, not browser evidence or
      // unresolved effects. A new transport is not proof an action failed.
      for (const key of new Set([
        ...controlViews.keys(),
        ...controlVisuals.keys(),
      ]))
        if (ControlTargetSchema.parse(JSON.parse(key)).kind === "window")
          invalidateControlTarget(key)
      connection.onClose(() => {
        if (client !== connection) return
        nativeRecordings.connectionEnded()
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
          native: { configured: Boolean(backend), catalog: "mako-control api --tool ACTION" },
          browser: { configured: Boolean(browserCall) },
          program: "mako-control exec",
          help: "mako-control api",
          input:
            "background by default; foreground requires explicit preflight",
          artifacts,
        }
      : {
          available: Boolean(backend),
          driverTools: (await tools()).length,
          program: "mako-control exec",
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
          help: "mako-control api",
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
      const detail: ComputerArguments = {
        action: tool.name,
        signature: signatureOf(tool),
        description: tool.description ?? "",
        notes: driverTool ? makoNotes(driverTool) : [],
        inputSchema: {
          type: "object",
          properties,
          required,
        },
      }
      if (tool.outputSchema !== undefined)
        detail.outputSchema = normalizeDriverSchema(tool.outputSchema)
      if (driverTool?.annotations !== undefined)
        detail.annotations = z.json().parse(driverTool.annotations)
      return detail
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
        "Every action is computer.<action>({...}) inside the internal driver test executor, beside the helpers view, act, until, expect, token, windows, fill, submit, routes and route and the browser object; call help({tool}) for one action's full schema.",
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
    signal: AbortSignal,
    beforeDispatch?: (args: ComputerArguments) => void
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
    if (tool.name === "get_window_state" && args.max_depth !== undefined && !input.properties?.max_depth)
      throw new ControlFault(
        "unsupported-operation",
        "This native driver does not advertise depth-limited reads. Update the driver or omit maxDepth; no observation was dispatched.",
        "not-dispatched"
      )
    if (tool.name === "click" && args.button === "middle" && !input.properties?.button)
      throw new ControlFault(
        "unsupported-operation",
        "This native driver does not advertise middle-click support; nothing was dispatched.",
        "not-dispatched"
      )
    if (
      (tool.name === "press_key" || tool.name === "hotkey") &&
      args.element_token !== undefined &&
      !input.properties?.element_token
    )
      throw new ControlFault(
        "unsupported-operation",
        "This native driver cannot address a keyboard action to a field; nothing was dispatched.",
        "not-dispatched"
      )
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
    if (args.delivery_mode === "foreground" && input.properties?.pid) {
      try {
        await verifyForegroundInput(connection, args, signal)
      } catch (error) {
        throw new ControlFault(
          "foreground-unavailable",
          error instanceof Error
            ? error.message
            : "Target focus could not be verified.",
          "not-dispatched"
        )
      }
    }
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
    const driverArgs = computerArgumentsSchema.parse(args)
    beforeDispatch?.(driverArgs)
    const raw = toolResultSchema.parse(
      await connection.callTool(tool.name, driverArgs, {
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
    signal: AbortSignal,
    beforeDispatch?: () => void
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
    beforeDispatch?.()
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
    if (refused !== undefined) {
      const message = refused.includes("AXUIElementPerformAction") && refused.includes("-25204")
        ? `${refused}. The app may have acted without acknowledging the request. Observe the window and any new dialog before deciding whether to repeat the action.`
        : refused
      throw new ControlFault("native-driver-error", message, "unknown")
    }
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
    const capabilities = windowCapabilities({
      platform: process.platform,
      target,
      // This is an admission hint, not proof of keyboard ownership. A transient
      // off-screen row need not block the route; the driver's fresh AX/window
      // preflight still refuses competing destinations before posting input.
      // Unknown visibility remains a possible competitor.
      documentWindows: windows.filter(
        (window) => window.kind === "document" && window.is_on_screen !== false
      ).length,
      onScreen: exact?.is_on_screen ?? null,
      pageBrowser: pageRoutes.get(target.pid)?.browser ?? undefined,
    })
    const available = await tools()
    const recording = available.find((tool) => tool.name === "start_recording")
    return {
      ...capabilities,
      screenshot: {
        scope: "exact-window",
        formats: ["png", "jpeg"],
        coordinates: "returned-image-pixels",
        element: false,
        maxSide: { min: 256, max: 4096, enlarges: false },
      },
      recording: {
        state: recording?.inputSchema.properties?.window_target
          ? "preflight-required"
          : "driver-update-required",
        scope: "exact-window",
        maxFps: nativeRecordingRate(recording).maxFps,
        cursor: "dispatched-pointer",
        requires: ["ffmpeg", "ffprobe", "supported native window capture"],
        completion: "record().stop() then recording.status()",
      },
    }
  }
  const controlTargets = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = controlInput(
      ControlTargetsRequestSchema.safeParse(raw),
      "discovery request",
      "Use control.apps(), control.windows(pid), control.browsers() or control.tabs(browserId)."
    )
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
    const request = controlInput(
      ControlObserveRequestSchema.safeParse(raw),
      "observation options",
      'Use observe({max:50,match:{role:"button",name:"Save"}}); optional keys: within, query, interactive. Each within scope requires both exact observed role and name, for example within:[{role:"form",name:"Shipping"}]. Use observe() if no named scope was observed. Native windows also accept maxDepth:1..25 to bound traversal; browser pages do not.'
    )
    const scope: ComputerArguments = { within: request.within }
    if (request.match) scope.match = request.match
    if (request.maxDepth !== undefined) scope.maxDepth = request.maxDepth
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
        lineage: value.lineage ?? null,
        lines,
        nodes,
        coverage,
        scope,
        viewport: value.viewport ?? null,
      }
      if (value.lineage === undefined) delete result.lineage
      if (value.matched !== undefined) result.matched = value.matched
      if (value.nextOffset !== undefined) result.nextOffset = value.nextOffset
      if (value.omitted !== undefined) result.omitted = value.omitted
      const observation = ControlObservationSchema.parse(result)
      reconcileControlTarget(request.target)
      return observation
    }
    // A failed refresh must not leave older controls actionable. Clear this
    // only after a complete, validated observation below.
    controlUncertain.add(key)
    const observationArgs: ComputerArguments = {
      pid: request.target.pid,
      window_id: request.target.window_id,
      max_elements: request.within.length || request.match ? 1000 : request.max,
      include_screenshot: false,
    }
    if (request.maxDepth !== undefined) observationArgs.max_depth = request.maxDepth
    const snapshot =
      controlData(
        await invokeTool(
          "get_window_state",
          observationArgs,
          signal
        )
      )
    const parsedSnapshot = nativeViewSchema.safeParse(snapshot)
    if (!parsedSnapshot.success) {
      if (snapshot.degraded === true)
        throw new ControlFault(
          "observation-unavailable",
          "The native driver could not provide accessibility controls for this window. A sheet may expose its controls through its parent window; observe that parent, or request a screenshot explicitly. No usable observation was created.",
          "rejected"
        )
      throw new ControlFault(
        "invalid-driver-response",
        "The native driver returned an invalid accessibility snapshot. Observe this window again before using its controls. No usable observation was created.",
        "unknown"
      )
    }
    const state = parsedSnapshot.data
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
      const node: z.infer<typeof ControlObservationSchema>["nodes"][number] = {
        depth: element.depth,
        role: nativeRole(element.role),
        nativeRole: element.role,
        name: element.label ?? "",
      }
      if (element.element_token) node.ref = element.element_token
      while (ancestors.length && ancestors.at(-1)!.depth >= node.depth)
        ancestors.pop()
      const web =
        element.in_web_content === true ||
        ancestors.some((ancestor) => nativeRole(ancestor.role) === "WebArea")
      ancestors.push({ depth: node.depth, role: element.role })
      if (
        element.editable !== false &&
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
      if (element.focused !== undefined) node.focused = element.focused
      if (element.editable !== undefined) node.editable = element.editable
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
    const webRefs = new Set(
      nodes.filter((node) => node.inputRoute === "page").map((node) => node.ref)
    )
    const lines = nodes.flatMap((node) =>
      pageElementLines([node]).map((line) => {
        if (node.inputRoute === "page") line += " [text input: page route]"
        if (node.valueExact === false) line += " [value is display-only]"
        return line
      })
    )
    controlViews.set(key, { observation: state.snapshot_id, lines })
    rememberControlRefs(request.target, state.snapshot_id, lines)
    for (const ref of webRefs) {
      if (!ref) continue
      const remembered = controlRefs.get(ref)
      if (remembered) remembered.webText = true
    }
    const observation = ControlObservationSchema.parse({
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
        omitted:
          state.total_element_count === undefined
            ? null
            : Math.max(
                0,
                state.total_element_count -
                  state.elements.length -
                  state.menu_bar_elements_omitted +
                  Math.max(0, scoped.length - nodes.length)
              ),
        textComplete: state.truncated !== true,
      },
    })
    const lineage = z.string().optional().parse(state.lineage)
    if (lineage !== undefined) observation.lineage = lineage
    reconcileControlTarget(request.target)
    return observation
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
      (operation.count === 3 ||
        (operation.button !== "left" && operation.count !== 1))
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
      if (operation.ref) args.element_token = operation.ref
      if (operation.modifiers.length > 0)
        args.keys = [...operation.modifiers, operation.key]
      else args.key = operation.key
      const action = operation.modifiers.length > 0 ? "hotkey" : "press_key"
      return controlData(await invokeTool(action, args, signal))
    }
    if (operation.kind === "pointer") {
      const args =
        "ref" in operation.at
          ? { ...base, element_token: operation.at.ref }
          : { ...base, x: operation.at.x, y: operation.at.y }
      if (operation.button === "middle")
        return controlData(await invokeTool("click", { ...args, button: "middle" }, signal))
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
      if (!signal.aborted) {
        const key = controlTargetKey(target)
        invalidateControlTarget(key)
        controlUncertain.add(key)
        pushControlEvent(target, "guard-unavailable", {
          action_id: actionId,
          recovery: "observe-target",
        })
        return
      }
    }
    pushControlEvent(target, "guard-settled", { action_id: actionId })
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
        controlVisuals.get(controlTargetKey(target))?.view !== operation.at.view
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
    const request = controlInput(
      ControlDispatchRequestSchema.safeParse(raw),
      "action request",
      'Use an exact target and operation:{kind,...}; see mako-control api --topic actions for action signatures.'
    )
    const key = request.target ? controlTargetKey(request.target) : undefined
    if (request.target && controlNeedsObservation(request.target))
      throw new ControlFault(
        "observation-required",
        "Previous action needs verification. Observe this exact target before another mutation; nothing was dispatched.",
        "not-dispatched"
      )
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
              platform: process.platform,
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
    validateControlRefs(request.target, request.operation)
    if (key && controlMutations.has(key))
      throw new ControlFault(
        "target-busy",
        "This target still has a pending mutation; nothing was dispatched.",
        "not-dispatched"
      )
    let operation = request.operation
    if (
      request.target?.kind === "window" &&
      (operation.kind === "pointer" || operation.kind === "scroll") &&
      operation.at &&
      "x" in operation.at
    ) {
      const geometry = controlVisuals.get(
        controlTargetKey(request.target)
      )?.native
      if (!geometry)
        throw new ControlFault(
          "stale-view",
          "Capture this exact window before using coordinates. Nothing was dispatched.",
          "not-dispatched"
        )
      operation = {
        ...operation,
        at: { ...operation.at, ...nativeCapturePoint(geometry, operation.at) },
      }
    }
    const endMutation = key ? beginControlMutation(key) : undefined
    let result: JsonValue
    let settling: NativeSettling | undefined
    let focusChange: NativeFocusChange | undefined
    try {
      result = z
        .json()
        .parse(
          await dispatchControlOperation(request.target, operation, signal)
        )
      if (signal.aborted)
        throw new ControlFault(
          "cancelled",
          "Input was dispatched before cancellation. Observe the exact target before continuing.",
          "unknown"
        )
      if (request.target?.kind === "window") {
        const native = z
          .object({
            settling: NativeSettlingSchema.optional(),
            focus_change: NativeFocusChangeSchema.optional(),
          })
          .parse(result)
        settling = native.settling
        focusChange = native.focus_change
        // Input was dispatched. A focus interruption requires a fresh view,
        // never an automatic retry or continuation on the old target state.
        if (focusChange && key) controlUncertain.add(key)
      }
    } catch (error) {
      const detail = controlFaultData(error)
      if (key && (!detail || detail.outcome === "unknown"))
        controlUncertain.add(key)
      throw new ControlFault(
        detail?.code ?? "dispatch-failed",
        error instanceof Error ? error.message : "Control dispatch failed",
        detail?.outcome ?? "unknown"
      )
    } finally {
      endMutation?.()
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
      try {
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
      } catch {
        // Monitoring failed after input completed. Preserve the dispatched
        // receipt, but require fresh target evidence before continuing.
        if (key) controlUncertain.add(key)
        guard = {
          status: "unavailable",
          action_id: actionId,
          recovery: "observe-target",
        }
        pushControlEvent(request.target, "guard-unavailable", {
          action_id: actionId,
        })
      }
    }
    const receipt: ComputerArguments = {
      status: "dispatched",
      actionId,
      route: plan.route,
      delivery: evidence.delivery,
      verification: "not-requested",
      guard,
    }
    if (settling) receipt.settling = settling
    if (focusChange) receipt.focus_change = focusChange
    if (request.operation.kind === "command") receipt.result = result
    return receipt
  }
  const controlEventValue = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = controlInput(
      ControlEventsRequestSchema.safeParse(raw),
      "event options",
      "Use handle.events({after:0,limit:20}); after and limit are numbers."
    )
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
    const request = controlInput(
      ControlRawRequestSchema.safeParse({ ...raw, backend }),
      "raw call",
      "Use handle.raw(name,args) with a method name and JSON object; consult control help for its schema."
    )
    if (backend === "native") {
      // These reads do not dispatch app input. Unknown tools are conservatively
      // treated as mutations; never infer safety from a tool's spelling.
      const readOnly = new Set([
        "list_apps",
        "list_windows",
        "get_config",
        "get_window_state",
        "get_accessibility_tree",
        "screenshot",
        "zoom",
      ]).has(request.name)
      const token = tokenSchema.safeParse(request.args.element_token).data
      const snapshotId =
        token?.split(":")[0] ??
        snapshotIdSchema.safeParse(request.args.snapshot_id).data
      const remembered = snapshotId ? snapshots.get(snapshotId) : undefined
      const target = ControlTargetSchema.safeParse({
        kind: "window",
        pid: request.args.pid ?? remembered?.pid,
        window_id: request.args.window_id ?? remembered?.window_id,
      }).data
      const key = target ? controlTargetKey(target) : undefined
      const nativeKeys = () =>
        [
          ...new Set([
            ...controlViews.keys(),
            ...controlVisuals.keys(),
            ...controlUncertain,
          ]),
        ].filter(
          (candidate) =>
            ControlTargetSchema.parse(JSON.parse(candidate)).kind === "window"
        )
      if (
        !readOnly &&
        (target
          ? controlNeedsObservation(target)
          : unscopedNativeUncertain ||
            nativeKeys().some((candidate) => controlUncertain.has(candidate)))
      )
        throw new ControlFault(
          "observation-required",
          "An action outcome is unknown. Observe an exact window, then use its handle for input. An observation cannot authorize input to an unspecified window; nothing was dispatched.",
          "not-dispatched"
        )
      let affected: string[] = []
      let dispatched = false
      const beforeDispatch = () => {
        affected = key ? [key] : nativeKeys()
        // A raw snapshot supersedes the driver's tokens even without input.
        if (!readOnly || request.name === "get_window_state")
          for (const candidate of affected) invalidateControlTarget(candidate)
        dispatched = true
      }
      try {
        const launchPage =
          request.name === "launch_app" && request.args.page_route === true
        const args = { ...request.args }
        if (launchPage) delete args.page_route
        const result = launchPage
          ? await launchWithPageRoute(args, signal, beforeDispatch)
          : controlData(
              await invokeTool(request.name, args, signal, beforeDispatch)
            )
        if (signal.aborted)
          throw new ControlFault(
            "cancelled",
            "Native call completed after cancellation. Observe the exact target before continuing.",
            "unknown"
          )
        return result
      } catch (error) {
        if (!dispatched)
          throw new ControlFault(
            controlFaultData(error)?.code ?? "native-preflight-failed",
            error instanceof Error ? error.message : "Native preflight failed",
            "not-dispatched"
          )
        if (!readOnly) {
          for (const candidate of affected) controlUncertain.add(candidate)
          if (!target) {
            unscopedNativeUncertain = true
            nativeReconciled.clear()
          }
        }
        throw error
      }
    }
    const command = controlInput(
      BrowserCommandSchema.safeParse({
        ...request.args,
        action: request.name,
      }),
      "page call",
      "Use the documented tab method and options. help({topic:'page'}) lists signatures; help({domain,method}) describes raw CDP."
    )
    if (!browserCall)
      throw new ControlFault(
        "unavailable",
        "Page control is unavailable outside a Mako task",
        "not-dispatched"
      )
    const target: PageTarget | undefined =
      "target" in command ? { kind: "page", ...command.target } : undefined
    const key = target ? controlTargetKey(target) : undefined
    const effect = browserCommandEffect(command)
    const answeringDialog =
      command.action === "dialog" &&
      command.respond !== undefined &&
      command.auto === undefined
    if (
      target &&
      effect === "mutate" &&
      !answeringDialog &&
      controlNeedsObservation(target)
    )
      throw new ControlFault(
        "observation-required",
        "Observe or capture this exact tab before another mutation; nothing was dispatched.",
        "not-dispatched"
      )
    if (key && effect === "observe") invalidateControlTarget(key)
    const mutating = effect === "mutate" || effect === "release"
    if (
      key &&
      mutating &&
      controlMutations.has(key) &&
      !(command.action === "cdp" && command.concurrent) &&
      command.action !== "dialog"
    )
      throw new ControlFault(
        "target-busy",
        "This target still has a pending mutation; nothing was dispatched.",
        "not-dispatched"
      )
    const profileMutation =
      command.action === "cookies" && command.operation !== "list"
    const affected = new Set(key ? [key] : [])
    if ((profileMutation && target) || command.action === "detach") {
      for (const candidate of [
        ...controlViews.keys(),
        ...controlVisuals.keys(),
        ...controlUncertain,
      ]) {
        const peer = ControlTargetSchema.parse(JSON.parse(candidate))
        if (
          peer.kind === "page" &&
          peer.browser ===
            (target?.browser ?? (command.action === "detach" ? command.id : ""))
        )
          affected.add(candidate)
      }
    }
    const endMutations = mutating ? [...affected].map(beginControlMutation) : []
    try {
      const result = await browserCall(command, signal)
      if (signal.aborted)
        throw new ControlFault(
          "cancelled",
          "Browser call completed after cancellation. Observe the exact target before continuing.",
          "unknown"
        )
      return result
    } catch (error) {
      const detail = controlFaultData(error)
      if (mutating && (!detail || detail.outcome === "unknown")) {
        for (const candidate of affected) controlUncertain.add(candidate)
        if (profileMutation && target) {
          uncertainProfiles.add(profileKey(target))
          pageReconciled.clear()
        }
      }
      throw new ControlFault(
        detail?.code ?? "browser-call-failed",
        error instanceof Error ? error.message : "Browser call failed",
        detail?.outcome ?? "unknown"
      )
    } finally {
      for (const end of endMutations) end()
    }
  }

  const rememberVisual = (
    key: string,
    view: string,
    native?: NativeCaptureGeometry
  ) => {
    controlVisuals.set(key, { view, native })
    while (controlVisuals.size > 64)
      controlVisuals.delete(controlVisuals.keys().next().value!)
  }
  const controlCapture = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = controlInput(
      z
        .object({
          target: ControlTargetSchema,
          options: computerArgumentsSchema.default({}),
        })
        .strict()
        .safeParse(raw),
      "capture request",
      "Use handle.screenshot({format?,quality?,maxSide?}); native capture also accepts screenshot_out_file."
    )
    const key = controlTargetKey(request.target)
    if (request.target.kind === "page") {
      if (!browserCall)
        throw new ControlFault(
          "unavailable",
          "Page control is unavailable outside a Mako task",
          "not-dispatched"
        )
      const command = controlInput(
        BrowserCommandSchema.safeParse({
          ...request.options,
          action: "screenshot",
          target: pageTarget(request.target),
        }),
        "page screenshot options",
        "Use {ref?,region?:{x,y,width,height},fullPage?,format?,quality?,maxSide?}; capture an element with tab.locator({role,name}).screenshot()."
      )
      invalidateControlTarget(key)
      const value = z
        .record(z.string(), z.json())
        .parse(await browserCall(command, signal))
      programImageSchema.parse(value)
      const view = z.string().min(1).parse(value.view)
      reconcileControlTarget(request.target)
      rememberVisual(key, view)
      return value
    }
    const captureOptions = controlInput(
      NativeScreenshotOptionsSchema.safeParse(request.options),
      "native screenshot options",
      "Use format, quality, maxSide or screenshot_out_file. Nothing was captured."
    )
    invalidateControlTarget(key)
    const driverOptions: ComputerArguments = {
      pid: request.target.pid,
      window_id: request.target.window_id,
      include_screenshot: true,
      include_accessibility_tree: false,
    }
    if (captureOptions.screenshot_out_file)
      driverOptions.screenshot_out_file = captureOptions.screenshot_out_file
    const value = controlData(
      await invokeTool("get_window_state", driverOptions, signal)
    )
    const content = z
      .object({ content: z.array(z.json()).default([]) })
      .parse(value).content
    const image = content
      .map((block) => programImageSchema.safeParse(block))
      .find((result) => result.success)
    const screenshotPath = z.string().safeParse(value.screenshot_file_path)
    let pixels = image?.success ? image.data : undefined
    if (!pixels && screenshotPath.success)
      pixels = {
        data: (await readFile(screenshotPath.data)).toString("base64"),
        mimeType: "image/png",
      }
    if (!pixels) throw new Error("The native driver returned no screenshot")
    const normalized = await nativeCapture(pixels, captureOptions)
    if (screenshotPath.success && normalized.changed)
      await writeFile(
        screenshotPath.data,
        Buffer.from(normalized.data, "base64")
      )
    const view = randomUUID()
    const receipt = programImageReceiptSchema.parse(value)
    if (receipt.screenshot_scale !== undefined)
      receipt.screenshot_scale *=
        normalized.geometry.imageWidth / normalized.geometry.sourceWidth
    const result = {
      ...receipt,
      data: normalized.data,
      mimeType: normalized.mimeType,
      coordinates: normalized.coordinates,
      view,
    }
    programImageSchema.parse(result)
    signal.throwIfAborted()
    rememberVisual(key, view, normalized.geometry)
    reconcileControlTarget(request.target)
    return result
  }

  const CONTROL_ACTIONS = [
    "help",
    "status",
    "capabilities",
    "targets",
    "connect",
    "observe",
    "dispatch",
    "events",
    "capture",
    "recording",
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
    const result = args.syntax === "repl" ? "" : "return "
    const reference = {
      version: 2,
      execution: "Mako agents use the persistent js MCP tool: top-level await and normal bindings, without top-level return; control.rewriteDocumentation() restores instructions. Shell users run mako-control exec --source-file workflow.js (or - for stdin). It waits for completion and preserves state between commands. Return only needed values; explicit images become files. Use mako-control api --topic examples for focused recipes.",
      examples: {
        discovery: `${result}await control.browsers()`,
        connectAndOpen: `// Use an exact ID from control.browsers(); connect is explicit.\nconst id='BROWSER_ID_FROM_DISCOVERY'; await control.connectBrowser(id); state.tab=await control.openTab({browser:id,url:'https://example.com'}); ${result}await state.tab.observe();`,
        existingTarget: `// Replace TARGET_JSON with the complete target returned by openTab/claimTab or CLI open/claim; preserve lease and generation.\nstate.tab=control.tab(TARGET_JSON); ${result}await state.tab.observe();`,
        dialog: `${result}await state.tab.dialog({}); // Inspect pending.type/message first. In a later command, after deciding: ${result}await state.tab.dialog({respond:'accept'});`,
        observedRef: `const view=await state.tab.observe(); const node=view.get({role:'textbox',name:'Name'}); await state.tab.setValue(node.ref,'Ada'); ${result}await state.tab.expect({role:'textbox',name:'Name',value:'Ada'});`,
        nativeWindow: `// Use the exact pid/window_id from apps() and windows(pid).\nstate.window=control.window({pid:1234,window_id:56}); ${result}await state.window.observe();`,
        scopedEdit:
          `const form=state.tab.locator({role:'form',name:'Profile'}); await form.locator({role:'textbox',name:'Name'}).setValue('Ada'); await form.locator({role:'button',name:'Save'}).click(); ${result}await state.tab.expect({within:[{role:'form',name:'Profile'}],role:'textbox',name:'Name',value:'Ada'});`,
        screenshot:
          "emitImage(await state.tab.locator({role:'form',name:'Profile'}).locator({role:'button',name:'Save'}).screenshot())",
        recordStart:
          `state.recording=await state.tab.record(); ${result}state.recording`,
        recordStop: `${result}await state.recording.stop()`,
        recordStatus: `${result}await state.recording.status()`,
        note: "Examples assume state.tab is your opened/claimed tab; substitute exact observed form/control names. Stop may return finalizing: collect status, never restart the recording. invalid-request and target-ambiguous are not-dispatched for that operation; earlier program steps may have completed. Correct just the failed step. Unknown outcomes require fresh target evidence before more input.",
      },
      discovery:
        "control.apps() -> {apps:[...]}; control.windows(pid) -> {kind:'windows',pid,windows:[...]}; control.browsers() -> {kind:'browsers',available,browsers:[{id,name,preferred,transport,guidance?,lastInterruption?,connection,...}]}; control.tabs(browser) -> {kind:'pages',browser,pages:[{targetId,title,url,selectable,...}]}. These methods return objects, not arrays. When a pid is already known, list only that process’s windows.",
      connection:
        `await control.connectBrowser(id) explicitly connects an exact discovered browser and returns its connection state. A disconnected desk is ready to connect without an extension or remote-debugging setup. Choose the dev desk by origin/sourceRoot; open a hidden task tab there to inspect or capture Mako. This is a separate view, not a screenshot of the user’s visible window. Chromium profiles still require their installed extension. Example: const {browsers} = await control.browsers(); await control.connectBrowser(browsers.find(b => b.id === chosenId).id); state.tab = await control.openTab({browser:chosenId}); ${result}await state.tab.observe(); No implicit reconnect or action replay.`,
      handles:
        "control.app({pid}).windows(), control.app({pid}).window(window_id), control.window({pid,window_id}), control.tab({kind:'page',browser,tab,generation,lease}), await control.openTab({browser?,url?,name?,background?,disposition?,lifetime?,context?}), await control.claimTab({browser,tab,takeover?}). Store handles in state across exec commands. App windows are selected explicitly; no implicit first window.",
      actions:
        "await handle.capabilities() returns this window’s routes or this page transport’s supported workflows, without a screenshot. handle.locator({role,name,within?}) keeps semantic intent; .locator({role,name}) nests scopes, .read({max?}) reads just that element’s subtree, .click(), .setValue(value), .pressKey(key), .selectOption({value}|{label}) each read once, require one complete match, then dispatch once. No retries. await handle.observe({within?:[{role,name}],match?:{role,name},query?,interactive?,max?}); Native window.observe also accepts maxDepth:1..25 (e.g. 5 for outer dialog controls); depth-limited reads remain incomplete when descendants are omitted and cannot prove absence or uniqueness. handle.setValue(ref,value), click(ref|{x,y,view},{button?,count?}), activate(ref), pressKey(key,{modifiers?,ref?}), scroll({deltaX?,deltaY?,at?}), selectOption(ref,{value}|{label}), events({after?,limit?}). Mutations return {status:'dispatched',actionId,route,delivery,verification:'not-requested',guard,settling?,focus_change?}; focus_change reports an observed native focus interruption (even if restored); reobserve before another action, never replay it. Missing focus_change is not proof of continuous focus isolation. native settling reports notification quiet/deadline/unavailable, never action success. Refs expire after mutation or observation.",
      observations:
        "Observation has nodes, lines, coverage, get({role,name,within?}) returns one node object; pass node.ref (a string) to setValue/click/activate, not the node object. select({role?,name?,text?,roles?,states?,includeAncestors?,max?}), diff(previous). Returning it emits compact lines once. Return .nodes only when full structured output is needed. role/name use the same exact names as get/locator; text searches role, accessibility name and value, not arbitrary visible DOM text. Each within scope requires both observed role and name, e.g. [{role:'form',name:'Shipping'}]; do not invent a form or omit its name. Use observe() when no named scope was observed. Strings only, not regular expressions. No automatic emission or screenshots. Native web text fields report inputRoute:page and pageBrowser when connected; claim and observe that exact page before typing. Use role names exactly as observed: native roles such as TextField/Button may differ from browser textbox/button. No app-specific instructions are assumed.",
      assertions:
        "await handle.expect({role,name,within?,value?,states?,absent?},{timeoutMs?,everyMs?}) polls fresh structured evidence without replaying actions. Exact value equality; duplicates fail. Absent requires complete coverage. Positive evidence is scoped to observed nodes, not proof of global uniqueness. Check coverage when the UI is partial.",
      recording:
        "await handle.record({directory?,name?,cursor?,maxDurationMs?,maxSide?,fps?}) starts explicit video capture of this tab or window. Keep the returned handle and receipt. After a program reset, await handle.recording(id) binds the existing recording from its exact receipt; it never starts another capture. recording.stop() starts finalization; recording.status() returns recording/finalizing/finished/interrupted/failed plus video, timeline paths and encoded dimensions when ready. The receipt’s frames field counts source frames (or retained samples when a source count is unavailable); browser video holds unchanged images using timestamps, so encoded frame count differs. Browser frameRate reports requestedFps, encodedFps (not distinct visual FPS), skippedFrameSlots under scheduling/encoder pressure, and unchangedFrameSlots saved by holding identical pixels. droppedFrames counts source queue evictions. Under contention, recording continues at reduced temporal sampling with original sharpness and duration; a stalled or failed encoder still reports interruption. encodedFrames/encodedDurationMs report retained playable output; a crash prefix can be shorter than capture duration. fps caps browser sampling and output (browser default/max 60; native defaults to the driver-advertised maximum, up to 60). maxSide caps output size; it does not fabricate source detail or alter devicePixelRatio. It records the agent cursor where dispatch coordinates are known, never the physical cursor. Media stays in files; capture stops when the task ends. ffmpeg is required. Native windows require the updated shared driver; unsupported window capture refuses without recording the desktop.",
      page: "tab.navigate(url,{waitUntil?,timeoutMs?}), screenshot({ref?,region?:{x,y,width,height},fullPage?,format?:png|jpeg,quality?,maxSide?}), upload(ref,files), dialog({auto?:'ask'|'accept'|'dismiss',respond?:'accept'|'dismiss',promptText?:string}), children(), retain(name), download({directory,ref?|url?,timeoutMs?}), downloadStatus(id,{timeoutMs?}), close(), release(), cdp(method,params?). tab.raw(name,args?) is the explicit page escape hatch; run mako-control api --domain DOMAIN --method METHOD for pinned CDP schemas. tab.locator({role,name}).screenshot({maxSide:2048}) reads and captures one exact element; emitImage(await ...) writes an image artifact; CLI output includes its receipt. dialog({}) reads pending without answering; respond answers only the current dialog, while auto changes future handling. A dialog-triggering click may already have run: inspect and answer it without repeating the click. Screenshot coordinates report actual image pixels and viewport CSS geometry; do not infer coordinates from a resized chat thumbnail. A Mako desk is a live client of the real app, not a side-effect-free sandbox, and refuses URLs outside its own origin. Profile/task/background defaults. name labels the task group; retain(name) keeps a result after task cleanup. children() returns {children:[{browser,tab,title,url}],note}; pass a child to control.claimTab(child). Extension downloads accept an explicit http(s) URL, await the browser-issued ID, and copy the completed file into a unique subdirectory of directory; browserPath retains the original. In-progress results have an id for downloadStatus, never repeat the start. Ref-triggered download routing and isolated contexts require direct CDP.",
      native:
        "window.screenshot({format?,quality?,maxSide?,screenshot_out_file?}) returns actual image geometry and a view token; coordinates use the returned image pixels with {x,y,view}, including resized captures, window.raw(name,args?), control.native(name,args?) for driver lifecycle/capabilities. Same host validation and foreground policy. Raw calls invalidate unified refs; observe before returning to high-level input.",
      command:
        "control.command({language:'shell'|'applescript'|'jxa',source,cwd?}) returns dispatch evidence plus result (stdout,stderr,exit_code,timed_out,truncated). Inspect exit_code; dispatch is not command success.",
      output:
        "return value or console.log(value); emitImage(await handle.screenshot()) writes image artifacts within output budgets. state retains handles across exec commands, checkpoint/recall retain bounded JSON facts; cancellation resets the worker. Await every action. Callbacks from a finished command cannot act in a later command.",
    }
    return args.topic
      ? { version: reference.version, [args.topic]: reference[args.topic] }
      : reference
  }
  let controlTail: Promise<unknown> = Promise.resolve()
  const commands: Array<{
    id: string
    action: (typeof CONTROL_ACTIONS)[number]
    target: ControlTarget | null
    outcome: string
    fault: string | null
    ms: number
  }> = []
  const runControl = async (
    command: ComputerArguments,
    signal: AbortSignal
  ): Promise<JsonValue> => {
    const action = controlInput(
      z.enum(CONTROL_ACTIONS).safeParse(command.action),
      "control action",
      "Use the documented control handles or a supported CLI command; see help()."
    )
    const started = performance.now()
    const target = ControlTargetSchema.safeParse(command.target)
    let outcome = "unknown"
    let fault: string | null = null
    try {
      const value = await dispatchControl(command, signal)
      outcome = "completed"
      return value
    } catch (error) {
      const detail = controlFaultData(error)
      outcome = detail?.outcome ?? "unknown"
      fault = detail?.code ?? "control-error"
      throw error
    } finally {
      commands.push({
        id: randomUUID(),
        action,
        target: target.success ? target.data : null,
        outcome,
        fault,
        ms: Math.round((performance.now() - started) * 100) / 100,
      })
      if (commands.length > 100) commands.shift()
    }
  }
  const dispatchControl = async (
    command: ComputerArguments,
    signal: AbortSignal
  ): Promise<JsonValue> => {
    const action = controlInput(
      z.enum(CONTROL_ACTIONS).safeParse(command.action),
      "control action",
      "Use the documented control handles or a supported CLI command; see help()."
    )
    const args = { ...command }
    delete args.action
    const invoke = async () => {
      if (closed)
        throw new Error("Local Control is closing; no new action was accepted")
      signal.throwIfAborted()
      if (action === "status") {
        controlInput(z.object({}).strict().safeParse(args), "status options", "Use control.status().")
        return status()
      }
      if (action === "help") return z.json().parse(await controlHelp(controlInput(
        controlHelpInputSchema.safeParse(args), "help options", 'Use {topic:"actions"} or {domain:"Page",method:"navigate"}.'
      )))
      if (action === "capabilities") {
        const target = controlInput(
          z.object({ target: ControlTargetSchema }).strict().safeParse(args),
          "capability target",
          "Use handle.capabilities() for an exact discovered window or claimed page."
        ).target
        if (target.kind === "window") return nativeCapabilities(target, signal)
        if (!browserCall)
          throw new Error("Page control is unavailable outside a Mako task")
        const pageTarget = {
          browser: target.browser,
          tab: target.tab,
          generation: target.generation,
          lease: target.lease,
        }
        return browserCall(
          BrowserCommandSchema.parse({
            action: "capabilities",
            target: pageTarget,
          }),
          signal
        )
      }
      if (action === "connect") {
        if (!browserCall)
          throw new Error("Page control is unavailable outside a Mako task")
        return browserCall(
          controlInput(
            BrowserCommandSchema.safeParse({ ...args, action: "connect" }),
            "browser connection",
            "Use control.connectBrowser(id) with an ID from control.browsers()."
          ),
          signal
        )
      }
      if (action === "targets") return controlTargets(args, signal)
      if (action === "observe" || action === "capture") {
        const target = controlInput(
          ControlTargetSchema.safeParse(args.target),
          "target",
          "Use the complete target returned by discovery/open/claim."
        )
        const key = controlTargetKey(target)
        if (controlMutations.has(key))
          throw new ControlFault(
            "target-busy",
            "Wait for this target's pending mutation before observing it; nothing was dispatched.",
            "not-dispatched"
          )
        const read = { interrupted: false }
        controlReads.set(key, read)
        try {
          return await (action === "observe"
            ? controlObserve(args, signal)
            : controlCapture(args, signal))
        } finally {
          controlReads.delete(key)
        }
      }
      if (action === "dispatch") return controlDispatch(args, signal)
      if (action === "events") return controlEventValue(args, signal)
      if (action === "recording") {
        const request = controlInput(
          z
            .object({
              target: ControlTargetSchema,
              operation: z.enum(["start", "stop", "status"]),
              id: z.string().min(1).optional(),
              options: computerArgumentsSchema.optional(),
            })
            .strict()
            .superRefine((value, ctx) => {
              if (value.operation !== "start" && !value.id)
                ctx.addIssue({
                  code: "custom",
                  path: ["id"],
                  message:
                    "stop/status requires the ID returned by record start",
                })
              if (value.operation === "start" && value.id !== undefined)
                ctx.addIssue({
                  code: "custom",
                  path: ["id"],
                  message: "start does not accept an existing recording ID",
                })
              if (value.operation !== "start" && value.options !== undefined)
                ctx.addIssue({
                  code: "custom",
                  path: ["options"],
                  message: "options apply only to record start",
                })
            })
            .safeParse(args),
          "recording request",
          "Use handle.record(options), then savedRecording.stop()/status(); recover with handle.recording(id). CLI uses record stop/status --input recording.json."
        )
        if (request.target.kind === "window") {
          if (request.operation !== "start") {
            const recording = nativeRecordings.get(
              request.target,
              z.string().min(1).parse(request.id)
            )
            return request.operation === "stop"
              ? recording.stop()
              : nativeRecordings.status(
                  request.target,
                  recording.id,
                  client,
                  session
                )
          }
          const available = await tools()
          if (!client)
            throw new Error("Native recording requires a connected driver")
          return nativeRecordings.start(
            request.target,
            controlInput(
              RecordingOptionsSchema.safeParse(request.options ?? {}),
              "recording options",
              "Use {directory?,name?,cursor?,maxDurationMs?,maxSide?,fps?}; native rates depend on the driver/backend capability."
            ),
            client,
            available,
            session,
            signal
          )
        }
        if (!browserCall) throw new Error("Browser recording needs a Mako task")
        return browserCall(
          BrowserCommandSchema.parse({
            ...request,
            action: "recording",
            target: pageTarget(request.target),
          }),
          signal
        )
      }
      return controlRaw(action, args, signal)
    }
    // Explicit concurrent CDP is needed to release a paused request or dialog.
    const concurrent =
      action === "events" ||
      (action === "page" &&
        (args.name === "dialog" ||
          (args.name === "cdp" &&
            z
              .object({ args: z.object({ concurrent: z.literal(true) }) })
              .safeParse(args).success)))
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
      replDocumentation: unified ? controlReplDocumentation : undefined,
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
  let finishing: Promise<void> | undefined
  const assertOpen = () => {
    if (closed)
      throw new ControlFault(
        "session-closed",
        "Local Control session is closed; no action was accepted.",
        "not-dispatched"
      )
  }
  return {
    instructions: unified ? controlInstructions : instructions,
    diagnostics() {
      return { commands: [...commands] }
    },
    async status() {
      assertOpen()
      return status()
    },
    async help(input: ComputerArguments = {}) {
      assertOpen()
      return z
        .json()
        .parse(
          unified
            ? await controlHelp(
                controlInput(
                  controlHelpInputSchema.safeParse(input),
                  "help options",
                  'Use {topic:"actions"}, {tool:"click"} or {domain:"Page",method:"navigate"}; method requires domain.'
                )
              )
            : await help(COMPUTER_TOOL_INPUTS.help.parse(input))
        )
    },
    async reference() {
      try {
        return renderReference((await tools()).map(asDriverTool))
      } catch (error) {
        return `Driver actions: unavailable (${error instanceof Error ? error.message : String(error)}). Session status reports when the driver is attached.`
      }
    },
    async execute(
      input: z.input<typeof ControlProgramRequestSchema>,
      signal: AbortSignal,
      execution: ControlProgramExecution = {}
    ): Promise<ControlProgramOutput[]> {
      assertOpen()
      const request = controlInput(
        ControlProgramRequestSchema.safeParse(input),
        "program request",
        'Use exactly one of {source:"<async JavaScript>"} or {cell:1}; copy the numeric cell from the running receipt.'
      )
      const active = await program()
      const cancelled = () => {
        if (request.source !== undefined) options.onProgramCancelled?.()
      }
      signal.addEventListener("abort", cancelled, { once: true })
      try {
        signal.throwIfAborted()
        return request.source !== undefined
          ? await active.run(request.source, signal, execution)
          : await active.wait(z.number().parse(request.cell), signal)
      } catch (error) {
        observations.submit({
          operation: "exec",
          target: "Selected application",
          status: "error",
        })
        throw error
      } finally {
        signal.removeEventListener("abort", cancelled)
      }
    },
    async resetProgram(signal: AbortSignal) {
      assertOpen()
      await (await program()).reset(signal)
    },
    async call(
      input: ComputerArguments,
      signal: AbortSignal
    ): Promise<JsonValue> {
      assertOpen()
      if (!unified)
        throw new ControlFault(
          "unsupported",
          "Direct commands require the unified control session.",
          "not-dispatched"
        )
      return runControl(computerArgumentsSchema.parse(input), signal)
    },
    close(): Promise<void> {
      return (finishing ??= (async () => {
        closed = true
        const pendingConnection = starting
        observations.close()
        await runtime?.close()
        try {
          await Promise.all([nativeRecordings.close(), browserCall?.close?.()])
        } finally {
          await closePageRoutes()
          await client?.close()
          await pendingConnection?.catch(() => {})
        }
      })())
    },
  }
}
export type ControlSession = ReturnType<typeof createControlSession>
