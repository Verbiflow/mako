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
  MAKO_ACTION_FLAGS,
  keyRouteAdvice,
  normalizeDriverSchema,
  programProperties,
  renderReference,
  signatureOf,
  summaryOf,
  toolResultData,
  toolResultError,
  withWindowKinds,
  withoutMenuBar,
  type DriverTool,
} from "@mako/control/computer"
import { driverSchemaValidator } from "./driver-schema.js"
import {
  ControlImageSchema,
  type ControlImage,
} from "./contracts/control-preview.js"
import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { parseArgs } from "node:util"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
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

How to work: windows(pid) to pick the document window; view(target) to read it as one line per element; act('click', {element_token}) for a step whose result you must see, since what changed comes back with it; chain steps in one program when each follows from the last without your judgement, with expect() guarding the assumptions and until() waiting for the screen; then answer. A window is about 800 tokens as view() lines and about 12,000 as get_window_state JSON: read with view, and use get_window_state when you need frames, actions or the screenshot. \`state\` persists between programs of this MCP client (the helpers keep state.target and state.last there); \`console.log(value)\` adds a text block; \`emitImage(result)\` adds the image a result carries (get_window_state with its screenshot, zoom) with its snapshot receipt; \`artifacts.save(name, value)\` writes a value or image to a file and returns its path. Your session identity is supplied automatically and cannot collide with another task; never pass session.

Grounding: an element_token alone addresses an action, because Mako remembers which pid and window produced each snapshot. Screenshot coordinates are window-local pixels of that window's latest capture (element frames are screen points: subtract window_bounds and multiply by screenshot_scale); for a small target zoom a region and pass from_zoom:true with coordinates read off the zoom image. Reobserve after acting: transport success is not proof the UI changed, and a timeout or cancellation does not prove an action did not run. A stale token or a missing window means rediscover, never another window.

Background input, in order (details in mako_computer_help().routes): 1 accessibility, set_value and element_token clicks, for anything an observed element exposes; this is how a backgrounded Electron or Chromium field is written, since set_value replaces text where a keyboard would select-all and retype. 2 window pointer with x,y. 3 invoke_menu for a menu item or its shortcut; the driver fronts the application briefly and restores the previous frontmost app itself. 4 pid keyboard (type_text, press_key, hotkey) for native Cocoa fields only: a Chromium or Electron renderer that is not frontmost drops every posted key, the result then carries escalation.reason 'delivery_failed' and mako_routes.status 'not-delivered', so switch route instead of retrying. 5 delivery_mode:'foreground', explicit; Mako verifies that the exact application and window are already frontmost and refuses otherwise, and never escalates on its own. Do not bring_to_front, launch_app or invoke_menu unless the task calls for it: the user is working in another application. Electron and Chromium windows ignore background scrolling on macOS; for a page inside a browser prefer Mako browser tools. A combo never focuses a field and is never driver-verifiable; read the field back. Do not repeat text based on delivered_chars alone: the driver can report zero when the field received everything.

Results: every action resolves to the driver's structured data, and a refused action throws with the driver's message; images ride on result.content. list_windows rows carry kind: document, helper or unknown, and helper strips are not windows. get_window_state omits the application's menu bar and the duplicate tree_markdown (include_menu_bar:true and include_markdown:true restore them) and defaults max_elements to ${DEFAULT_MAX_ELEMENTS}. A returned or logged value at or past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB, and every image after the ${INLINE_IMAGE_COUNT}th in one program, is written whole to a file and the result carries a receipt with the path, size, hash and an outline of the value's shape; nothing is cut. Programs stop after ${PROGRAM_TIME_LIMIT_MS / 1000} seconds; on timeout, cancellation or an error the worker and \`state\` reset while the driver session, snapshots and Mako's checks remain. Scripts are trusted local code, not an OS sandbox; every action still passes Mako's session, snapshot, path, foreground and preview checks.

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
const snapshotSchema = z.object({
  snapshot_id: z.string().min(1),
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
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
      "Input route: background by default and never fronts the window. delivery_mode:'foreground' is explicit; Mako first verifies that this exact application and window are already frontmost and refuses otherwise. It never escalates automatically."
    )
  if (KEYBOARD_TOOLS.has(tool.name))
    notes.push(
      KEY_ROUTE_ADVICE.notDelivered.reason,
      KEY_ROUTE_ADVICE.notDelivered.routes,
      KEY_ROUTE_ADVICE.unverifiable.reason
    )
  return notes
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
  // Snapshot ids stay valid across calls, but the driver still wants the pid
  // and window that produced them; remember both so a token is enough.
  const snapshots = new Map<string, { pid: number; window_id: number }>()
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
  const status = async () => ({
    available: Boolean(backend),
    driverTools: (await tools()).length,
    program: "mako_computer_exec",
    helpers: ["view", "act", "until", "expect", "windows"],
    help: "mako_computer_help",
    inputRoutes: {
      default: "background",
      order: BACKGROUND_INPUT_LADDER.map((rung) => rung.route),
      foreground: "explicit-preflight",
      preflight: ["active-application", "front-window"],
      automaticEscalation: false,
    },
    artifacts,
  })
  const help = async (args: z.infer<typeof COMPUTER_TOOL_INPUTS.help>) => {
    const available = await tools()
    if (args.tool !== undefined) {
      const tool = available.find((candidate) => candidate.name === args.tool)
      if (!tool)
        throw new Error(
          `Unknown computer action "${args.tool}". Actions: ${available.map((candidate) => candidate.name).join(", ")}.`
        )
      const driverTool = asDriverTool(tool)
      const { properties, required } = programProperties(driverTool)
      return {
        action: tool.name,
        signature: signatureOf(driverTool),
        description: tool.description ?? "",
        notes: makoNotes(tool),
        inputSchema: {
          type: "object",
          properties,
          required,
        },
        outputSchema: tool.outputSchema
          ? normalizeDriverSchema(z.json().parse(tool.outputSchema))
          : undefined,
        annotations: tool.annotations,
      }
    }
    return {
      actions: available.map(asDriverTool).map((tool) => ({
        action: tool.name,
        signature: signatureOf(tool),
        summary: summaryOf(tool),
      })),
      routes: BACKGROUND_INPUT_LADDER,
      reference: renderReference(available.map(asDriverTool)),
      program:
        "Every action is computer.<action>({...}) inside mako_computer_exec, beside the helpers view, act, until, expect and windows; call help({tool}) for one action's full schema.",
    }
  }
  const rememberSnapshot = (
    structuredContent: z.infer<typeof toolResultSchema>["structuredContent"]
  ) => {
    const snapshot = snapshotSchema.safeParse(structuredContent)
    if (!snapshot.success) return
    if (snapshots.size >= 64) {
      const oldest = snapshots.keys().next().value
      if (oldest !== undefined) snapshots.delete(oldest)
    }
    snapshots.set(snapshot.data.snapshot_id, {
      pid: snapshot.data.pid,
      window_id: snapshot.data.window_id,
    })
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
    const includeMarkdown = args.include_markdown === true
    const includeMenuBar = args.include_menu_bar === true
    for (const flag of Object.keys(MAKO_ACTION_FLAGS[tool.name] ?? {}))
      delete args[flag]
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
    const raw = toolResultSchema.parse(
      await client.callTool({ name: tool.name, arguments: args }, undefined, {
        signal,
        timeout: 60_000,
      })
    )
    if (tool.name === "get_window_state")
      rememberSnapshot(raw.structuredContent)
    const result =
      tool.name === "get_window_state"
        ? compactWindowState(raw, { includeMarkdown, includeMenuBar })
        : tool.name === "list_windows"
          ? withStructured(raw, withWindowKinds)
          : KEYBOARD_TOOLS.has(tool.name)
            ? withKeyRouteAdvice(raw)
            : raw
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
  const program = async () => {
    const available = await tools()
    runtime ??= new ControlProgramRuntime({
      namespace: "computer",
      actions: ["status", "help", ...available.map((tool) => tool.name)],
      artifacts,
      call: async (command, signal) => {
        const action = z.string().parse(command.action)
        const args = { ...command }
        delete args.action
        if (action === "status") return status()
        if (action === "help")
          return z
            .json()
            .parse(await help(COMPUTER_TOOL_INPUTS.help.parse(args)))
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
        description: `Run a computer control program: trusted async JavaScript. Read a window with view(), take a step and see what changed with act(), guard chained steps with expect() and until(), and call any driver action as computer.<action>(args); state persists, console.log adds text, emitImage adds an image, artifacts.save writes a file. Await every call and return only what you need to decide. Results are never truncated: a value past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB is written to a file and described. ${PROGRAM_TIME_LIMIT_MS / 1000}-second limit; every action keeps Mako's session, snapshot, path, foreground and preview checks.

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
