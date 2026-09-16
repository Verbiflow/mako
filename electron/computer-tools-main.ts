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
} from "@mako/control/program"
import {
  actionReceipt,
  BACKGROUND_INPUT_LADDER,
  diffLines,
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
  shownValue,
  toolResultData,
  toolResultError,
  withWindowKinds,
  windowCapabilities,
  withReceiptVerification,
  withoutEscalationNudge,
  withoutMenuBar,
  type DriverTool,
  type SnapshotIndex,
} from "@mako/control/computer"
import {
  ControlActRequestSchema,
  ControlAdvancedRequestSchema,
  ControlEventsRequestSchema,
  ControlObserveRequestSchema,
  ControlTargetsRequestSchema,
  ControlWaitRequestSchema,
  controlLineRef,
  pageElementLines,
  planControlOperation,
  type ControlTarget,
  type PageTarget,
  type WindowControlTarget,
} from "@mako/control/control"
import {
  BROWSER_ACTIONS,
  type BrowserCall,
} from "./browser-tools-runtime.js"
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

Background input, in order (details in mako_computer_help().routes): 1 accessibility — fill, set_value and element_token clicks (action press/pick/confirm/open), for anything an observed element exposes; this is how a backgrounded Electron or Chromium field is written, since set_value replaces text where a keyboard would select-all and retype. 2 page route — launch_app({bundle_id, page_route: true}) starts an Electron or Chromium app in the background with a private DevTools port and registers it as browser 'app:<bundle_id>'; the browser object is available in every computer program (browser.tabs({browser}), browser.select, browser.click, browser.type, browser.press, browser.observe, browser.screenshot), with keyboard, pointer, DOM reads and screenshots that never touch focus. 3 command — script and shell. 4 window pointer with x,y. 5 pid keyboard (type_text, press_key, hotkey): native Cocoa fields only and never a Cmd chord — Mako refuses a background Cmd chord before it is posted because an application that is not frontmost does not dispatch menu key equivalents (force: true posts it anyway); a Chromium or Electron renderer that is not frontmost drops every posted key; the driver cannot read keys back, so send them through act() and let the delta say whether they landed, and treat mako_routes.status 'unconfirmed' as a reason to read, not to retry. 6 invoke_menu for a menu item or its shortcut: the driver fronts the application for the call and restores the previous frontmost app itself, so it requires foreground: true and reports fronted.ms. 7 delivery_mode:'foreground' with foreground: true: Mako verifies that the exact application and window are already frontmost and refuses otherwise; bring_to_front requires foreground: true too. Mako never fronts on its own, and a result never asks you to: the user is working in another application. Electron and Chromium windows ignore background scrolling on macOS; use their page route. Do not repeat text based on delivered_chars alone: the driver can report zero when the field received everything.

Results: every action resolves to the driver's structured data, and a refused action throws with the driver's message (Mako's own refusals — a fronting call without foreground: true, a background Cmd chord — throw before the driver is asked); images ride on result.content. A call that fronted carries fronted: {pid, ms}, and mako_computer_status counts them for the task. list_windows rows carry kind: document, helper or unknown, and helper strips are not windows. get_window_state omits the application's menu bar and the duplicate tree_markdown (include_menu_bar:true and include_markdown:true restore them) and defaults max_elements to ${DEFAULT_MAX_ELEMENTS}. A returned or logged value at or past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB, and every image after the ${INLINE_IMAGE_COUNT}th in one program, is written whole to a file and the result carries a receipt with the path, size, hash and an outline of the value's shape; nothing is cut. Programs stop after ${PROGRAM_TIME_LIMIT_MS / 1000} seconds; on timeout, cancellation or an error the worker and \`state\` reset while the driver session, snapshots and Mako's checks remain. Scripts are trusted local code, not an OS sandbox; every action still passes Mako's session, snapshot, path, foreground and preview checks.

Output and input file paths (screenshot_out_file, output_dir, destination_root, files) may be absolute, ~-rooted or relative to the working directory; Mako resolves symlinked parents such as /tmp before the driver inspects them. macOS permissions, Chrome debugging consent and provider tool approval are distinct.`
const controlInstructions = `Mako control is one provider-neutral code API for pages, native windows and system automation. Use mako_control_exec and the control object; Mako chooses the backend from the exact target and operation. Models do not choose CDP versus accessibility versus pointer delivery.

If the task gives exact pid/window_id or a page handle, construct that target directly; do not rediscover it. Otherwise discover only the missing class with control.targets({kind:'browsers'|'pages'|'apps'|'windows', ...}), then control.observe({target, interactive:true}) for compact lines. A browser target with kind:'desk', origin and sourceRoot is an active Mako development host: choose the row matching the requested Vite origin or checkout, even when this task runs in the installed app. It creates its page in that host's hidden renderer, needs no Chromium profile and must never fall back to this host's plain 'mako' target. Use \`control.ref(line)\` to extract the exact first token and call control.act({target, operation:{kind:'set-text'|'activate'|'press-key'|'pointer'|'scroll'|'select-option', ...}}); never split a line by punctuation. Every action returns its host plan, a receipt, a compact post-action observation and a delta. Its observation mints the refs for the next known step, so chain from action.observation instead of making another observation. Page targets always use the page route; exact window targets use the strongest proven background route. Foreground-required or unsupported plans are returned without dispatch. System work is operation:{kind:'command', language:'shell'|'applescript'|'jxa', source}; it never touches focus.

Chain deterministic steps in one async JavaScript program. Return when the next action needs semantic judgement. For page-specific work, \`page.open({browser,url?,disposition:'tab'|'window',lifetime:'task'|'persistent',context:'profile'|'isolated'})\` and \`page.claim\` mint exact page targets; background task-lifetime profile pages are the defaults and close with the control client. Isolated contexts require direct CDP and are disposed as one task resource; extension transports refuse them instead of pretending. \`page.observe\` keeps a structured AX tree inside the worker, \`page.select\` filters it by role, text and state with ancestor context, \`page.lines\` renders only that working set, and typed \`page.cdp\` reaches the complete pinned Chrome protocol. Call mako_control_help({domain, method?}) only when a protocol command is needed. control.wait({target, contains, hidden?, timeout_ms?}) polls locally, and control.events({target, after?}) reads page protocol events or Mako's bounded native topology events. control.advanced({backend, name, args}) remains the raw escape hatch for capabilities the closed operation contract does not yet express. \`state\`, bounded \`checkpoint\`/\`recall\`, artifact spilling and resumable cells work the same in every harness. Results are never truncated; oversized values are written whole to an artifact with a receipt.

Refs belong to one backend, exact target and latest observation. Reobserve after every action; never carry a ref across targets or observations. A set-text receipt of suspected-noop may be reobserved and retried once because setting the same value is idempotent; never replay a pointer, activation or unknown outcome. Mako refuses unsafe background key chords and never fronts an application implicitly. Browser, Accessibility and Screen Recording permissions remain separate.`
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
    domain: z
      .string()
      .optional()
      .describe("Chrome DevTools Protocol domain to inspect for page.cdp."),
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
  windows: z.array(
    z.looseObject({
      window_id: z.number().int().optional(),
      kind: z.string().optional(),
      is_on_screen: z.boolean().nullable().optional(),
    })
  ),
})
const nativeViewSchema = z.looseObject({
  snapshot_id: z.string(),
  elements: z.array(z.json()).default([]),
})
const pageViewSchema = z.looseObject({
  observation: z.string(),
  nodes: z.array(z.json()).default([]),
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
  const controlRefs = new Map<
    string,
    { target: string; observation: string }
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
        await connection.callTool(name, { session, ...rest }, {
          signal,
          timeout: 10_000,
        })
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
  const status = async (): Promise<ComputerArguments> => ({
    available: unified ? Boolean(backend || browserCall) : Boolean(backend),
    driverTools: (await tools()).length,
    program: `${toolPrefix}_exec`,
    helpers: unified
      ? ["targets", "observe", "act", "wait", "events", "advanced"]
      : [
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
      preflight: ["foreground-flag", "active-application", "front-window"],
      automaticEscalation: false,
      backgroundCmdChords: "refused before dispatch unless force: true",
    },
    frontingEvents,
    pageRoutes: await pageRouteValue(),
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
      await connection.callTool(tool.name, computerArgumentsSchema.parse(args), {
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
    const listed = windowRowsSchema.safeParse(
      toolResultData(await invokeTool("list_windows", { pid }, signal))
    )
    return listed.success ? listed.data.windows : []
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
      return toolResultData(await invokeTool("list_apps", {}, signal))
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
    const key = controlTargetKey(request.target)
    if (request.target.kind === "page") {
      if (!browserCall)
        throw new Error("Page control is unavailable outside a Mako task")
      const value = pageViewSchema.parse(
        await browserCall(
          BrowserCommandSchema.parse({
            action: "observe",
            target: pageTarget(request.target),
            maxNodes: request.max,
            query: request.query,
            interactiveOnly: request.interactive,
          }),
          signal
        )
      )
      const lines = pageElementLines(value.nodes)
      controlViews.set(key, { observation: value.observation, lines })
      rememberControlRefs(request.target, value.observation, lines)
      const result: ComputerArguments = {
        target: request.target,
        route: "page",
        observation: value.observation,
        lines,
        viewport: value.viewport ?? null,
      }
      if (value.matched !== undefined) result.matched = value.matched
      if (value.nextOffset !== undefined)
        result.nextOffset = value.nextOffset
      if (value.omitted !== undefined) result.omitted = value.omitted
      return result
    }
    const state = nativeViewSchema.parse(
      toolResultData(
        await invokeTool(
          "get_window_state",
          {
            pid: request.target.pid,
            window_id: request.target.window_id,
            max_elements: request.max,
          },
          signal
        )
      )
    )
    const lines = elementLines(state.elements, {
      interactive: request.interactive,
      query: request.query,
    })
    controlViews.set(key, { observation: state.snapshot_id, lines })
    rememberControlRefs(request.target, state.snapshot_id, lines)
    return {
      target: request.target,
      route: "accessibility",
      observation: state.snapshot_id,
      lines,
    }
  }
  const dispatchControlOperation = async (
    target: ControlTarget | undefined,
    operation: z.infer<typeof ControlActRequestSchema>["operation"],
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
    const base = { pid: target.pid, window_id: target.window_id }
    if (operation.kind === "set-text")
      return toolResultData(
        await invokeTool(
          "set_value",
          { ...base, element_token: operation.ref, value: operation.text },
          signal
        )
      )
    if (operation.kind === "activate")
      return toolResultData(
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
      return toolResultData(await invokeTool(action, args, signal))
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
      return toolResultData(await invokeTool(action, args, signal))
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
      return toolResultData(
        await invokeTool("scroll", args, signal)
      )
    }
    const value = z.string().parse(operation.value ?? operation.label)
    return toolResultData(
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
    operation: z.infer<typeof ControlActRequestSchema>["operation"]
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
    operation: z.infer<typeof ControlActRequestSchema>["operation"]
  ) => {
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
        throw new Error(
          `Ref "${ref}" is not from this target's latest observation. Observe the exact target again; nothing was dispatched.`
        )
    }
  }
  const controlAct = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlActRequestSchema.parse(raw)
    validateControlRefs(request.target, request.operation)
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
      return { dispatched: false, plan, receipt: null }
    const before = request.target
      ? controlViews.get(controlTargetKey(request.target))
      : undefined
    const result = await dispatchControlOperation(
      request.target,
      request.operation,
      signal
    )
    let after =
      request.operation.kind === "command" || !request.target
        ? undefined
        : await controlObserve(
            {
              target: request.target,
              interactive: false,
              max: DEFAULT_MAX_ELEMENTS,
            },
            signal
          )
    let afterLines = after ? z.array(z.string()).parse(after.lines) : []
    const expectedText =
      request.operation.kind === "set-text"
        ? shownValue(request.operation.text)
        : undefined
    if (expectedText && request.target && !afterLines.some((line) => line.includes(expectedText))) {
      const deadline = Date.now() + 800
      while (Date.now() < deadline) {
        await wait(100, signal)
        after = await controlObserve(
          {
            target: request.target,
            interactive: false,
            max: DEFAULT_MAX_ELEMENTS,
          },
          signal
        )
        afterLines = z.array(z.string()).parse(after.lines)
        if (afterLines.some((line) => line.includes(expectedText))) break
      }
    }
    const delta = before
      ? diffLines(before.lines, afterLines)
      : { added: [], removed: [], unchanged: 0 }
    const confirmed =
      expectedText
        ? afterLines.some((line) => line.includes(expectedText))
        : delta.added.length > 0 || delta.removed.length > 0
    const target =
      request.target?.kind === "window"
        ? {
            pid: request.target.pid,
            window_id: request.target.window_id,
          }
        : undefined
    const baseReceipt = actionReceipt(
      request.operation.kind,
      {},
      target,
      { route: plan.route, result: z.json().parse(result) }
    )
    const receipt = withReceiptVerification(
      {
        ...baseReceipt,
        route: plan.route,
        outcome:
          expectedText && !confirmed
            ? "suspected-noop"
            : baseReceipt.outcome,
      },
      {
        kind: plan.verification,
        status:
          plan.verification === "direct" || confirmed
            ? "confirmed"
            : delta.added.length > 0 || delta.removed.length > 0
              ? "changed"
              : "unchanged",
      }
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
    return {
      dispatched: true,
      action_id: actionId,
      plan,
      receipt,
      guard,
      observation: after,
      delta,
    }
  }
  const controlWait = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlWaitRequestSchema.parse(raw)
    const deadline = Date.now() + request.timeout_ms
    let observation: Awaited<ReturnType<typeof controlObserve>>
    for (;;) {
      observation = await controlObserve(
        {
          target: request.target,
          interactive: request.interactive,
          max: DEFAULT_MAX_ELEMENTS,
        },
        signal
      )
      const lines = z.array(z.string()).parse(observation.lines)
      const found = lines.some((line) => line.includes(request.contains))
      if (found !== request.hidden)
        return { matched: true, observation, elapsed_ms: request.timeout_ms - (deadline - Date.now()) }
      if (Date.now() >= deadline)
        return { matched: false, observation, elapsed_ms: request.timeout_ms }
      await wait(
        Math.min(request.every_ms, Math.max(1, deadline - Date.now())),
        signal
      )
    }
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
      .filter(
        (event) => event.target === key && event.cursor > request.after
      )
      .slice(0, request.limit)
    return {
      events,
      next:
        events.at(-1)?.cursor ?? Math.max(request.after, controlEventCursor),
    }
  }
  const controlAdvanced = async (
    raw: ComputerArguments,
    signal: AbortSignal
  ) => {
    const request = ControlAdvancedRequestSchema.parse(raw)
    if (request.backend === "native")
      return toolResultData(
        await invokeTool(request.name, request.args, signal)
      )
    if (request.backend === "page") {
      if (!browserCall)
        throw new Error("Page control is unavailable outside a Mako task")
      return browserCall(
        BrowserCommandSchema.parse({
          action: request.name,
          ...request.args,
        }),
        signal
      )
    }
    if (request.name !== "shell" && request.name !== "script")
      throw new Error('System advanced actions are "shell" or "script"')
    return makoAction(request.name, request.args, signal)
  }
  const CONTROL_ACTIONS = [
    "status",
    "targets",
    "observe",
    "act",
    "wait",
    "events",
    "advanced",
  ] as const
  const controlHelp = async (
    args: z.infer<typeof controlHelpInputSchema> = {}
  ) => {
    if (args.domain !== undefined)
      return browserProtocolHelp(args.domain, args.method)
    return {
    actions: [
      {
        action: "targets",
        signature:
          "targets({kind:'browsers'|'pages'|'apps'|'windows', browser?, pid?})",
        purpose: "Discover only the class of target needed next.",
      },
      {
        action: "observe",
        signature: "observe({target, query?, interactive?, max?})",
        purpose:
          "Return compact ref-bearing lines from the exact page or window.",
      },
      {
        action: "act",
        signature: "act({target?, operation})",
        purpose:
          "Plan, dispatch and verify one closed-contract operation through the strongest proven route.",
      },
      {
        action: "wait",
        signature:
          "wait({target, contains, hidden?, timeout_ms?, every_ms?, interactive?})",
        purpose:
          "Poll observations locally until text appears or disappears.",
      },
      {
        action: "events",
        signature: "events({target, after?, limit?})",
        purpose:
          "Read page protocol events or bounded native topology guard events.",
      },
      {
        action: "advanced",
        signature: "advanced({backend:'native'|'page'|'system', name, args})",
        purpose:
          "Explicit escape hatch for a capability the closed operation contract does not express.",
      },
    ],
    operationKinds: [
      "set-text",
      "activate",
      "press-key",
      "pointer",
      "scroll",
      "select-option",
      "command",
    ],
    targetKinds: ["page", "window"],
    routing:
      "The host planner selects the route. A page target uses page control; a window target uses capability-proven accessibility, window pointer or pid keyboard; command uses the system adapter. Foreground is never selected implicitly.",
    refs:
      "A ref belongs to the exact target and its latest observation. Call control.ref(line) to extract it; never split a line by punctuation. Reobserve after every action.",
    page:
      "page.open({browser,url?,background?,disposition?:'tab'|'window',lifetime?:'task'|'persistent',context?:'profile'|'isolated'}), page.claim({browser,tab,takeover?}), page.release(target), page.close(target), page.observe(target, options?), page.select(observation, {text?,roles?,states?,refsOnly?,includeAncestors?,max?}), page.lines(selection), page.cdp(target, method, params?). Task-lifetime background profile pages are the defaults; isolated contexts require direct CDP. page is page-only code over the same host ownership and validation as control.",
    protocol:
      "Call mako_control_help with domain to list its commands and events, or domain plus method for the exact pinned Chrome protocol schema.",
    native: unified
      ? (await tools()).map((tool) => tool.name)
      : [],
    }
  }
  const program = async () => {
    const available = await tools()
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
        if (unified) {
          const action = z.enum(CONTROL_ACTIONS).parse(command.action)
          const args = { ...command }
          delete args.action
          if (action === "status")
            return z.json().parse({
              ...(await status()),
              surface: "control",
              asyncNativeGuard,
            })
          if (action === "targets")
            return z
              .json()
              .parse(
                await controlTargets(
                  computerArgumentsSchema.parse(args),
                  signal
                )
              )
          if (action === "observe")
            return z
              .json()
              .parse(
                await controlObserve(
                  computerArgumentsSchema.parse(args),
                  signal
                )
              )
          if (action === "act")
            return z
              .json()
              .parse(
                await controlAct(
                  computerArgumentsSchema.parse(args),
                  signal
                )
              )
          if (action === "wait")
            return z
              .json()
              .parse(
                await controlWait(
                  computerArgumentsSchema.parse(args),
                  signal
                )
              )
          if (action === "events")
            return z
              .json()
              .parse(
                await controlEventValue(
                  computerArgumentsSchema.parse(args),
                  signal
                )
              )
          return z
            .json()
            .parse(
              await controlAdvanced(
                computerArgumentsSchema.parse(args),
                signal
              )
            )
        }
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
      await browserCall?.close?.()
      await closePageRoutes()
      await client?.close()
    }
  }
  const statusTool = `${toolPrefix}_status`
  const helpTool = `${toolPrefix}_help`
  const execTool = `${toolPrefix}_exec`
  const server = new ComputerServer(
    { name: unified ? "mako-control" : "mako-driver-test-runtime", version: "4.0.0" },
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
        description:
          unified
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
        description:
          unified
            ? "Reference for the closed control contract, page code helpers, deterministic routing and the advanced escape hatch. With domain and optional method, returns the pinned Chrome protocol schema for page.cdp."
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
          ? `Run or resume provider-neutral control code. Pass {source} with trusted async JavaScript, or {cell} to resume a yielded program. Use control.targets, control.observe, control.act, control.wait and control.events; Mako owns route selection and returns a plan, receipt, observation and delta. The page helper provides exact page lifecycle, structured AX selection and typed CDP without bypassing host ownership. If pid/window_id or a page handle is already known, construct that exact target directly. A known sequence belongs in one program: observe once, act, then take the next ref from action.observation and act again. Use control.advanced only when neither the closed contract nor page helper expresses the task. Return when the next step needs model judgement. Results are never truncated: a value past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB is written whole to an artifact with a receipt. ${PROGRAM_TIME_LIMIT_MS / 1000}-second hard limit.

checkpoint({objective?, location?, remember?: {key: value}, completed?: string[], pending?: string[]}) stores bounded task memory; remember is an object, not prose. recall() reads it.

${JSON.stringify(await controlHelp())}`
          : `Run or resume a computer control program: pass {source} with trusted async JavaScript, or {cell} when a program yields after ten seconds and continues. Read a window with view(), take and verify a step with act(), write a field with fill(), press Enter with submit(), select a proven route with route(), and guard chained steps with expect() and until(); state and bounded checkpoint/recall task memory survive cells. Await every action and return only what you need to decide. Nothing fronts the user's application without foreground: true on the call. Results are never truncated: a value past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB is written to a file and described. ${PROGRAM_TIME_LIMIT_MS / 1000}-second hard limit; every action keeps Mako's session, snapshot, path, foreground and preview checks.

checkpoint({objective?, location?, remember?: {key: value}, completed?: string[], pending?: string[]}) stores bounded task memory; remember is an object, not prose. recall() reads it.

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
          const input = COMPUTER_TOOL_INPUTS.exec.parse(request.params.arguments)
          const active = await program()
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
        operation: request.params.name.replace(/^mako_(?:computer|control)_/, ""),
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
