import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  BrowserCommandSchema,
  BrowserFault,
} from "./contracts/browser-control.js"
import { browserControlClient } from "./browser-control-client.js"
import {
  BROWSER_ACTIONS,
  actionNameOf,
  BrowserToolsRuntime,
  type BrowserCall,
} from "./browser-tools-runtime.js"
import { browserProtocolHelp } from "./browser-protocol-help.js"
import {
  INLINE_IMAGE_COUNT,
  INLINE_TEXT_BUDGET,
  PROGRAM_TIME_LIMIT_MS,
} from "@mako/control/program"
import { isMainModule } from "./main-module.js"

const descriptions = {
  status:
    'Read browser connection state without connecting, prompting, or opening tabs. Browser IDs identify connected extension profiles, plus "mako" for hidden windows of Mako\'s own interface. Only the mako entry means no Chrome profile has the Mako Browser extension connected yet.',
  connect:
    "Connect the selected browser profile through its installed Mako Browser extension. Installation grants browser access; ordinary reconnects do not require another debugging approval. Concurrent tasks join the same pending connection. Closing an MCP client does not disconnect Chrome.",
  tabs: "List existing page, iframe and worker targets in a connected browser, with identity, URL, title, whether it is selectable as a page, and whether a task has claimed it. Does not select or activate a tab.",
  open: "Create and claim a new tab in a connected browser. Background by default. Returns the exact target handle for all later calls plus the navigation outcome; a failed navigation still returns the handle.",
  select:
    "Claim the exact tab ID you inspected in tabs. Explicit takeover can transfer an idle tab from another task. Never selects a substitute or activates the tab.",
  release:
    "Release this task's exact tab binding. Leaves the tab and the shared Chrome connection open.",
  observe:
    "Read the exact tab's title, URL, viewport scroll position and accessibility nodes within a 60 KB page. Each node carries depth, role, name, value and live states (checked, disabled, focused, expanded, selected, required, pressed, level, url). Fresh refs address elements for click, type, press, hover, scroll, screenshot and upload; a changed observation or navigation replaces them. Pass since with the prior observation token while polling: an unchanged page returns a compact receipt and preserves its refs, while any change returns a complete fresh observation. Use interactiveOnly to see just controls, query to filter by text, and offset with nextOffset to page through a large tree.",
  screenshot:
    "Return an actual image, a visual view token, exact target identity and coordinate mapping. JPEG is the compact default; the longest side is 1568 px unless maxSide says otherwise. Use region to magnify a viewport rectangle, ref for one observed element, or fullPage for the document. Does not change the selected target or reconnect.",
  evaluate:
    "Evaluate JavaScript in the exact tab and return the CDP result by value. Supports async expressions. May modify page state; use observations to read ordinary UI. For user interaction, use click/type/press: DOM click(), submit(), and dispatchEvent() do not produce trusted user input.",
  cdp: "Send a Chrome DevTools Protocol command to this exact target. Supports DOM, Runtime, Input, Network, Emulation, Page dialogs and other permitted protocol domains. Chrome extensions do not expose Browser/SystemInfo commands; those require an explicitly configured direct-CDP transport. Target lifecycle uses open/select/release/close so ownership remains explicit. Use concurrent:true to answer a paused Fetch request or JavaScript dialog while another command is waiting. No failed command is replayed.",
  events:
    "Read a bounded, non-destructive event history for this exact tab: at most limit events (default 32) within 60 KB. Pass the returned cursor as after to continue; more reports remaining events and gap reports evicted history. Use cdp to enable needed domains, e.g. Network.enable. Page events are enabled automatically.",
  navigate:
    "Navigate this exact tab. By default waits for this navigation’s load event (up to timeoutMs, default 30 seconds); waitUntil:domcontentloaded returns earlier and waitUntil:commit returns once the navigation is accepted. A redirect counts as the same navigation. Expiry returns completion:timeout rather than failing; observe afterwards to verify the result. Supports http, https, about and data URLs.",
  close:
    "Close this exact tab. Its old handle becomes invalid. Does not close Chrome or another task's tab.",
  click:
    'Click a fresh observation ref or exact viewport CSS coordinates in the bound tab. Ref clicks scroll the element into view and verify it is present and not covered. Pass at as an object, for example {"ref":"observed-ref"} or {"x":100,"y":200,"view":"latest-view-token"}. Include the screenshot view token so stale visual coordinates are refused. Sends a real pointer move, press and release; count:2 double-clicks; modifiers hold keys. Does not move the physical pointer.',
  hover:
    "Move the pointer over a ref or viewport coordinates without pressing, to open hover menus and tooltips. Observe or screenshot afterwards to see the result.",
  scroll:
    "Scroll with a real wheel event at a ref, at viewport coordinates, or at the viewport centre. Positive deltaY scrolls down. Returns the resulting window scroll position; observe or screenshot afterwards to read the new content.",
  type: "Insert text through Chrome's Input domain. With ref, focuses that exact editable element first and reports its tag; without ref, types into the tab's focused element and refuses when nothing editable is focused. clear:true removes the field's current content first; submit:true presses Enter afterwards.",
  press:
    'Press one key with optional modifiers: a printable character such as "a" or "/", or Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, PageUp, PageDown, Space, F1-F12. Sends real key down and up events. An optional ref receives focus first.',
  upload:
    "Set explicit absolute local file paths on an observed file-input ref in this exact tab. Empty files clears the input. This may upload file contents to the page.",
  dialog:
    "Read, answer, or set policy for JavaScript dialogs (alert, confirm, prompt, beforeunload) on this tab. An open dialog blocks every other action until answered; respond accept or dismiss, with promptText for prompts. auto:accept or auto:dismiss answers future dialogs immediately and records them in events; auto:ask (default) leaves them for you.",
  download:
    "Save one file download into an existing absolute directory. Start it by clicking at a ref or coordinates, or by requesting a url, then wait until the browser reports completion. Returns the suggested filename, path and size; the browser may rename a clashing file.",
  pdf: "Print the current document to a PDF at an absolute local path. Options: landscape, printBackground, scale, paper size in inches, page ranges.",
  cookies:
    "List, set, delete, or clear cookies through this tab's session. list returns names, domains, paths, expiry and flags for the tab's URL (or urls); values are included only with includeValues:true. clear removes every cookie in the browser profile.",
  frames:
    "List the tab's frame tree: id, parent, url, name, origin and depth. Same-process frames accept frameId on observe and evaluate; out-of-process iframes are their own targets in tabs.",
  wait: "Wait up to timeoutMs for conditions: a CSS selector, body text, a URL substring, or network idle (no requests in flight for 500 ms). hidden inverts selector and text. Returns satisfied true or false with the elapsed time instead of failing.",
  history:
    "Go back or forward in this tab's history, or reload, and wait up to ten seconds for the load event. Reports whether the tab moved and its resulting URL.",
  selectOption:
    "Choose an option in an observed <select> by value or label and fire its input and change events. Lists the available options when nothing matches.",
}
const descriptionByAction = new Map<string, string>(
  Object.entries(descriptions)
)
const serializedInput = z.object({
  properties: z.record(z.string(), z.json()),
  required: z.array(z.string()).optional(),
  $defs: z.record(z.string(), z.json()).optional(),
})

interface ActionReference {
  action: string
  signature: string
  summary: string
  description: string
  inputSchema: Record<string, z.infer<typeof z.json>>
}

/** The browser API as a program sees it, derived from the wire contract. */
function actionReference(): ActionReference[] {
  return BrowserCommandSchema.options.map((schema) => {
    // Input mode keeps defaulted fields optional; output mode would
    // publish every default as required.
    const input = serializedInput.parse(z.toJSONSchema(schema, { io: "input" }))
    const action = actionNameOf(schema)
    delete input.properties.action
    const required = new Set(
      input.required?.filter((name) => name !== "action") ?? []
    )
    const parameters = Object.keys(input.properties).map((name) =>
      required.has(name) ? name : `${name}?`
    )
    const description = descriptionByAction.get(action) ?? ""
    const inputSchema: ActionReference["inputSchema"] = {
      type: "object",
      properties: input.properties,
      required: [...required],
      additionalProperties: false,
    }
    if (input.$defs) inputSchema.$defs = input.$defs
    return {
      action,
      signature: `browser.${action}({${parameters.join(", ")}})`,
      summary: description.split(/(?<=\.)\s/)[0] ?? "",
      description,
      inputSchema,
    }
  })
}
const reference = actionReference()
const referenceByAction = new Map(
  reference.map((entry) => [entry.action, entry])
)

const apiReference = reference
  .map((entry) => `${entry.signature} — ${entry.summary}`)
  .join("\n")

const instructions = `Mako browser control is one program tool. mako_browser_exec runs trusted async JavaScript in a local worker with a \`browser\` object whose methods are the actions below; a single action is a one-line program (\`return await browser.tabs({browser:'chrome'})\`) and a workflow is several awaited calls with plain JavaScript between them, so intermediate results never pass through your context. Await every call. \`state\` persists between runs of this MCP client (keep tab handles there); \`console.log(value)\` adds a text block; \`emitImage(await browser.screenshot({...}))\` adds a real image with its view token and coordinate mapping; \`artifacts.save(name, value)\` writes a value or image to a file and returns its path. Read mako_browser_status first; call mako_browser_help({action}) for one action's full schema and mako_browser_help({domain, method}) for Chrome DevTools Protocol commands.

API (required arguments plain, optional with ?):
${apiReference}

Output is never cut. A returned or logged value at or past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB, and every image after the ${INLINE_IMAGE_COUNT}th in one run, is written whole to a file and the result carries a receipt with the path, size, hash and an outline of the value's shape (keys and their sizes, array length and samples). Prefer returning the narrow selection you need; read a receipt's file only when you need the whole. Programs stop after ${PROGRAM_TIME_LIMIT_MS / 1000} seconds; on timeout, cancellation or an error the worker and \`state\` reset while host tab bindings and the shared Chrome connection remain. Scripts are trusted local code, not an OS sandbox. Browser actions keep exact task ownership and are never replayed; an action that fails validation dispatches nothing and says so.

Targets: one host-owned Chrome connection serves every task. Connect the chosen browser if status shows it disconnected, then open a tab or inspect tabs and select an exact ID. Keep the returned {browser,tab,generation,lease} handle; every later call names it, there is no implicit active tab. Page bindings enable focus emulation so hidden tabs receive real input without activating the physical tab; release disables it. A target-closed or stale-target error requires explicit rediscovery, never choosing the first available tab.

Perception: observe gives accessible UI and fresh element refs; pass since with its observation token when polling so an unchanged tree returns only a receipt and keeps those refs valid. screenshot gives pixels, a view token and coordinate mapping; region magnifies one viewport rectangle without changing browser zoom. Pass the view token with coordinate actions so an older visual target is refused after another capture or action. A changed observation or a navigation invalidates earlier refs. Never guess refs, tab IDs or coordinates. Cross-check UI changes after actions; a cancelled or timed-out action may have completed, so observe before deciding what to do next. The host refuses further mutations on an uncertain binding until it is observed. click, hover, scroll, type and press send real input events; type reports the field it wrote into, and press covers keys that insertText cannot send (Enter, Tab, arrows, shortcuts).

Protocol: cdp enables network inspection, emulation, dialogs, frame inspection and download configuration without another browser runtime. Use open/select/release/close for target lifecycle, never raw Target mutations. For request interception or dialogs, enable the relevant domain first, read events, and use cdp with concurrent:true to unblock the pending operation; otherwise calls on one target are serialized. A page dialog blocks the tab until dialog answers it; set its auto policy when a page is expected to raise dialogs. wait covers selectors, text, URL changes and network idle; download, pdf, cookies, frames, history and selectOption cover the rest of a page's lifecycle.

The browser with ID "mako" is Mako itself: open creates a hidden window of Mako's own interface (1600×1000, larger than the screen if needed) that only this task sees, so you can inspect, screenshot and drive the desk without touching the window the user is working in. It hosts Mako's interface only and does not navigate to other sites; close the tab when finished. Prefer it over computer tools whenever the target is Mako.

For native windows, OS dialogs or content outside a browser page, use Mako computer tools. Browser connection approval is separate from macOS Accessibility/Screen Recording and provider tool approval. Local browser control never automatically switches to a hosted browser.`

export const BROWSER_TOOL_INPUTS = {
  status: z.object({}).strict(),
  exec: z
    .object({
      source: z
        .string()
        .min(1)
        .max(100_000)
        .describe(
          "Async JavaScript body. Call browser.<action>({...}) and await every call; return the value you want to see."
        ),
    })
    .strict(),
  help: z
    .object({
      action: z
        .string()
        .optional()
        .describe(
          "A browser action name. Returns its full input schema and description."
        ),
      domain: z
        .string()
        .optional()
        .describe(
          "A Chrome DevTools Protocol domain, for cdp. Lists its commands and events."
        ),
      method: z
        .string()
        .optional()
        .describe(
          "A command in that protocol domain. Returns its parameters and referenced types."
        ),
    })
    .strict(),
}

function browserHelp(args: z.infer<typeof BROWSER_TOOL_INPUTS.help>) {
  if (args.action !== undefined) {
    const entry = referenceByAction.get(args.action)
    if (!entry)
      throw new BrowserFault({
        code: "invalid-request",
        message: `Unknown browser action "${args.action}". Actions: ${BROWSER_ACTIONS.join(", ")}.`,
        outcome: "not-dispatched",
      })
    return {
      action: entry.action,
      signature: entry.signature,
      description: entry.description,
      inputSchema: entry.inputSchema,
    }
  }
  if (args.domain !== undefined || args.method !== undefined)
    return browserProtocolHelp(args.domain, args.method)
  return {
    actions: reference.map((entry) => ({
      action: entry.action,
      signature: entry.signature,
      summary: entry.summary,
    })),
    protocol:
      "Call help with a domain to list Chrome DevTools Protocol commands, or with domain and method for one command's schema.",
  }
}

export function createBrowserToolsServer(
  call: BrowserCall = browserControlClient(),
  taskId = process.env.MAKO_TASK_ID
): Server {
  const runtime = new BrowserToolsRuntime(call, taskId)
  class BrowserServer extends Server {
    override async close(): Promise<void> {
      await super.close()
      await runtime.close()
    }
  }
  const server = new BrowserServer(
    { name: "mako-browser-use", version: "3.0.0" },
    { capabilities: { tools: {}, logging: {} }, instructions }
  )
  server.onclose = () => {
    void runtime.close()
  }
  server.setRequestHandler(ListToolsRequestSchema, () =>
    ListToolsResultSchema.parse({
      tools: [
        {
          name: "mako_browser_status",
          description: descriptions.status,
          inputSchema: z.toJSONSchema(BROWSER_TOOL_INPUTS.status, {
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
          name: "mako_browser_help",
          description:
            "Reference for the browser program API. With no arguments, lists every browser.<action> signature. With action, returns that action's full input schema and description. With a Chrome DevTools Protocol domain (and method), returns protocol command schemas for browser.cdp.",
          inputSchema: z.toJSONSchema(BROWSER_TOOL_INPUTS.help, {
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
          name: "mako_browser_exec",
          description: `Run a browser control program: trusted async JavaScript with browser.<action>({...}) for every action in the server instructions, persistent state, console.log, emitImage and artifacts.save. One action or a whole workflow; await every call and return what you need to see. Results are never truncated: oversized values are written to files and described. ${PROGRAM_TIME_LIMIT_MS / 1000}-second limit; actions keep exact task ownership and are never replayed.`,
          inputSchema: z.toJSONSchema(BROWSER_TOOL_INPUTS.exec, {
            io: "input",
          }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
      ],
    })
  )
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let dispatched = false
    try {
      switch (request.params.name) {
        case "mako_browser_status": {
          BROWSER_TOOL_INPUTS.status.parse(request.params.arguments ?? {})
          const value = await call({ action: "status" }, extra.signal)
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: { value },
          }
        }
        case "mako_browser_help": {
          const value = await browserHelp(
            BROWSER_TOOL_INPUTS.help.parse(request.params.arguments ?? {})
          )
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
          }
        }
        case "mako_browser_exec": {
          const { source } = BROWSER_TOOL_INPUTS.exec.parse(
            request.params.arguments
          )
          dispatched = true
          return { content: await runtime.run(source, extra.signal) }
        }
        default:
          throw new BrowserFault({
            code: "invalid-request",
            message: `Unknown tool ${request.params.name}. Browser control is mako_browser_status, mako_browser_help and mako_browser_exec; every action is a browser.<action> call inside mako_browser_exec.`,
            outcome: "not-dispatched",
          })
      }
    } catch (error) {
      const fault =
        error instanceof BrowserFault
          ? error.detail
          : {
              code: dispatched ? "protocol-error" : "invalid-request",
              message:
                error instanceof z.ZodError
                  ? `Invalid arguments for ${request.params.name}. ${z.prettifyError(error).replace(/\s+/g, " ").trim()}`
                  : error instanceof Error
                    ? error.message
                    : "Browser operation failed",
              outcome: dispatched ? "unknown" : "not-dispatched",
            }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(fault) }],
        structuredContent: fault,
      }
    }
  })
  return server
}

export async function startBrowserToolsServer(): Promise<void> {
  const server = createBrowserToolsServer()
  const close = () => {
    void server.close().catch(reportStartupFailure)
  }
  process.stdin.once("end", close)
  process.once("SIGTERM", close)
  process.once("SIGINT", close)
  await server.connect(new StdioServerTransport())
}
function reportStartupFailure(error: Error): void {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
if (isMainModule(import.meta.url))
  void startBrowserToolsServer().catch(reportStartupFailure)
