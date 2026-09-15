import { z } from "zod"

export const BrowserStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connecting") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("awaiting-approval"), startedAt: z.number() }),
  z.object({ status: z.literal("connected"), generation: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
])
export type BrowserConnectionState = z.infer<typeof BrowserStateSchema>
export interface BrowserControlStatus {
  id: string
  name: string
  connection: BrowserConnectionState
}

export const BrowserTargetSchema = z
  .object({
    browser: z.string().describe("Browser ID from status."),
    tab: z.string().describe("Exact tab ID from tabs, open or select."),
    generation: z
      .string()
      .describe("Chrome connection generation the handle was minted under."),
    lease: z
      .string()
      .describe("Claim lease from the latest open or select call."),
  })
  .strict()
  .describe(
    "Exact tab handle returned by open or select. Pass it back unchanged; every field is required."
  )
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>
export const BrowserFaultCodeSchema = z.enum([
  "unavailable",
  "approval-required",
  "disconnected",
  "target-closed",
  "target-busy",
  "stale-target",
  "invalid-request",
  "protocol-error",
  "cancelled",
  "timed-out",
  "outcome-unknown",
  "output-limit",
])
export const BrowserFaultSchema = z.object({
  code: BrowserFaultCodeSchema,
  message: z.string(),
  outcome: z.enum(["not-dispatched", "rejected", "unknown"]),
})
export type BrowserFaultData = z.infer<typeof BrowserFaultSchema>
export class BrowserFault extends Error {
  readonly detail: BrowserFaultData
  constructor(detail: BrowserFaultData) {
    super(detail.message)
    this.detail = detail
  }
}

const ref = z
  .string()
  .min(1)
  .describe(
    "Element ref from this tab's latest observe result. Refs are replaced by the next observation and by navigation."
  )
const browser = z.string().describe("Browser ID from status.")
const VisualRegionSchema = z
  .object({
    x: z.number().finite().nonnegative().describe("Viewport CSS pixel X."),
    y: z.number().finite().nonnegative().describe("Viewport CSS pixel Y."),
    width: z
      .number()
      .finite()
      .positive()
      .describe("Region width in CSS pixels."),
    height: z
      .number()
      .finite()
      .positive()
      .describe("Region height in CSS pixels."),
  })
  .strict()
/** Where an input lands: an observed element or exact viewport CSS pixels. */
const PointerTargetSchema = z
  .union([
    z.object({ ref }).strict(),
    z
      .object({
        x: z.number().finite().describe("Viewport CSS pixel X."),
        y: z.number().finite().describe("Viewport CSS pixel Y."),
        view: z
          .string()
          .optional()
          .describe(
            "Visual view token returned by screenshot. When supplied, the action is refused unless it names this tab's latest agent screenshot."
          ),
      })
      .strict(),
  ])
  .describe(
    'An object, never a JSON string: {"ref":"<observed ref>"} or {"x":100,"y":200} in viewport CSS pixels from this tab\'s latest screenshot coordinates.'
  )
export const KeyModifierSchema = z.enum(["Alt", "Control", "Meta", "Shift"])

export const BrowserCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("connect"), browser }).strict(),
  z
    .object({
      action: z.literal("attach"),
      id: z
        .string()
        .regex(/^app:[A-Za-z0-9._-]+(?::\d+)?$/)
        .describe(
          "Browser id for the application: app:<bundle_id>, or app:<bundle_id>:<pid> for a second instance."
        ),
      name: z.string().min(1).max(120).describe("Display name."),
      endpoint: z
        .string()
        .url()
        .describe(
          "The application's DevTools browser endpoint, ws://127.0.0.1:<port>/devtools/browser/<id>, read from its /json/version. Loopback only."
        ),
    })
    .strict(),
  z.object({ action: z.literal("tabs"), browser }).strict(),
  z
    .object({
      action: z.literal("open"),
      browser,
      url: z
        .string()
        .default("about:blank")
        .describe(
          "http, https, about or data URL to load. Default about:blank."
        ),
      background: z
        .boolean()
        .default(true)
        .describe(
          "Create the tab without activating it in the physical window. Default true."
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("select"),
      browser,
      tab: z.string().describe("Exact tab ID from tabs."),
      takeover: z
        .boolean()
        .default(false)
        .describe(
          "Transfer an idle tab bound to another task. Default false: refuse a tab another task owns."
        ),
    })
    .strict(),
  z
    .object({ action: z.literal("release"), target: BrowserTargetSchema })
    .strict(),
  z
    .object({
      action: z.literal("observe"),
      target: BrowserTargetSchema,
      maxNodes: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(250)
        .describe("Most nodes to return after filtering. Default 250."),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          "Skip this many matching nodes first; use nextOffset from a truncated result to continue."
        ),
      query: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Case-insensitive filter on role, name and value. Ancestors are not included."
        ),
      interactiveOnly: z
        .boolean()
        .default(false)
        .describe(
          "Return only focusable and control nodes (buttons, links, fields, options)."
        ),
      since: z
        .string()
        .optional()
        .describe(
          "Observation token from this tab. If its semantic result is unchanged, return a compact unchanged receipt and keep its refs valid; otherwise return a complete fresh observation."
        ),
      frameId: z
        .string()
        .optional()
        .describe(
          "Observe one same-process frame from frames instead of the whole page. Out-of-process iframes are separate targets in tabs."
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("screenshot"),
      target: BrowserTargetSchema,
      format: z
        .enum(["png", "jpeg"])
        .default("jpeg")
        .describe("Image format. Default jpeg."),
      quality: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(80)
        .describe("JPEG quality 1-100. Default 80. Ignored for png."),
      fullPage: z
        .boolean()
        .default(false)
        .describe("Capture the whole document instead of the viewport."),
      maxSide: z
        .number()
        .int()
        .min(256)
        .max(4096)
        .default(1568)
        .describe(
          "Longest image side in pixels. Default 1568, the size vision models read without downscaling."
        ),
      ref: ref
        .optional()
        .describe(
          "Capture only this observed element's box (plus a small margin)."
        ),
      region: VisualRegionSchema.optional().describe(
        "Magnify an arbitrary rectangle from the current viewport. Coordinates are viewport CSS pixels. Incompatible with ref and fullPage."
      ),
    })
    .strict(),
  z
    .object({
      action: z.literal("evaluate"),
      target: BrowserTargetSchema,
      expression: z
        .string()
        .min(1)
        .max(100_000)
        .describe(
          "JavaScript expression evaluated in the page; a returned promise is awaited. A result past the inline budget is written whole to an artifact file and described, never cut."
        ),
      frameId: z
        .string()
        .optional()
        .describe(
          "Evaluate inside one same-process frame from frames, in an isolated world that sees its DOM but not its scripts' globals."
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("cdp"),
      target: BrowserTargetSchema,
      method: z
        .string()
        .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
        .describe("Protocol command such as Network.enable."),
      params: z
        .record(z.string(), z.json())
        .default({})
        .describe("Command parameters object. Default {}."),
      concurrent: z
        .boolean()
        .optional()
        .describe(
          "Run beside a waiting command on the same tab, e.g. to answer a dialog or paused request."
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("events"),
      target: BrowserTargetSchema,
      after: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Return events with a cursor above this value. Default 0."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(128)
        .default(32)
        .describe("Most events to return. Default 32."),
    })
    .strict(),
  z
    .object({
      action: z.literal("navigate"),
      target: BrowserTargetSchema,
      url: z.string().describe("http, https, about or data URL."),
      waitUntil: z
        .enum(["load", "domcontentloaded", "commit"])
        .optional()
        .describe(
          "How long to wait: load (default), domcontentloaded, or commit (return once the navigation is accepted)."
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(120_000)
        .optional()
        .describe(
          "Wait budget in milliseconds. Default 30000. Expiry returns completion:timeout instead of failing."
        ),
    })
    .strict(),
  z
    .object({ action: z.literal("close"), target: BrowserTargetSchema })
    .strict(),
  z
    .object({
      action: z.literal("click"),
      target: BrowserTargetSchema,
      at: PointerTargetSchema,
      button: z
        .enum(["left", "right", "middle"])
        .default("left")
        .describe("Mouse button. Default left."),
      count: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(1)
        .describe("Click count: 2 for double-click. Default 1."),
      modifiers: z
        .array(KeyModifierSchema)
        .max(4)
        .optional()
        .describe("Modifier keys held during the click."),
    })
    .strict(),
  z
    .object({
      action: z.literal("hover"),
      target: BrowserTargetSchema,
      at: PointerTargetSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      target: BrowserTargetSchema,
      at: PointerTargetSchema.optional().describe(
        "Where to scroll. Default: the viewport centre."
      ),
      deltaX: z
        .number()
        .finite()
        .default(0)
        .describe("Horizontal wheel delta in CSS pixels. Default 0."),
      deltaY: z
        .number()
        .finite()
        .default(0)
        .describe(
          "Vertical wheel delta in CSS pixels; positive scrolls down. Default 0."
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("type"),
      target: BrowserTargetSchema,
      text: z.string().max(100_000).describe("Text to insert at the caret."),
      ref: ref
        .optional()
        .describe(
          "Editable element to focus first. Without it the tab's focused element receives the text."
        ),
      clear: z
        .boolean()
        .default(false)
        .describe("Select the field's current content and delete it first."),
      submit: z
        .boolean()
        .default(false)
        .describe("Press Enter after inserting the text."),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      target: BrowserTargetSchema,
      key: z
        .string()
        .min(1)
        .max(32)
        .describe(
          'Key name: a printable character such as "a" or "/", or Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, F1-F12.'
        ),
      modifiers: z
        .array(KeyModifierSchema)
        .max(4)
        .optional()
        .describe("Modifier keys held while pressing."),
      ref: ref.optional().describe("Element to focus before the key press."),
    })
    .strict(),
  z
    .object({
      action: z.literal("dialog"),
      target: BrowserTargetSchema,
      respond: z
        .enum(["accept", "dismiss"])
        .optional()
        .describe(
          "Answer the open alert, confirm, prompt or beforeunload dialog."
        ),
      promptText: z
        .string()
        .max(10_000)
        .optional()
        .describe("Text to submit when accepting a prompt dialog."),
      auto: z
        .enum(["ask", "accept", "dismiss"])
        .optional()
        .describe(
          "Policy for future dialogs on this tab: ask (default) leaves them open for you to answer; accept or dismiss answers them immediately and records them in events."
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("download"),
      target: BrowserTargetSchema,
      directory: z
        .string()
        .min(1)
        .max(4096)
        .describe("Absolute, existing local directory that receives the file."),
      at: PointerTargetSchema.optional().describe(
        "Element or coordinates to click to start the download."
      ),
      url: z
        .string()
        .optional()
        .describe("URL to request instead of clicking; http or https."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(300_000)
        .default(60_000)
        .describe(
          "How long to wait for the download to finish. Default 60000."
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("pdf"),
      target: BrowserTargetSchema,
      path: z
        .string()
        .min(1)
        .max(4096)
        .describe(
          "Absolute local file path for the PDF; its directory must exist."
        ),
      landscape: z.boolean().default(false).describe("Landscape orientation."),
      printBackground: z
        .boolean()
        .default(true)
        .describe("Print background colours and images. Default true."),
      scale: z
        .number()
        .min(0.1)
        .max(2)
        .default(1)
        .describe("Rendering scale. Default 1."),
      paperWidth: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe("Paper width in inches. Default 8.5."),
      paperHeight: z
        .number()
        .positive()
        .max(100)
        .optional()
        .describe("Paper height in inches. Default 11."),
      pageRanges: z
        .string()
        .max(200)
        .optional()
        .describe('Pages to print, e.g. "1-3, 5". Default all.'),
    })
    .strict(),
  z
    .object({
      action: z.literal("cookies"),
      target: BrowserTargetSchema,
      operation: z
        .enum(["list", "set", "delete", "clear"])
        .describe(
          "list cookies for the tab's URL (or urls), set one or more cookies, delete matching cookies, or clear every cookie in the profile."
        ),
      urls: z
        .array(z.string().max(4096))
        .max(20)
        .optional()
        .describe(
          "URLs whose cookies to list. Default: the tab's current URL."
        ),
      includeValues: z
        .boolean()
        .default(false)
        .describe(
          "Include cookie values when listing. Default false: names, domains, paths, expiry and flags only."
        ),
      cookies: z
        .array(
          z
            .object({
              name: z.string().min(1).max(4096),
              value: z.string().max(65_536),
              url: z.string().max(4096).optional(),
              domain: z.string().max(4096).optional(),
              path: z.string().max(4096).optional(),
              secure: z.boolean().optional(),
              httpOnly: z.boolean().optional(),
              sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
              expires: z.number().optional().describe("Unix time in seconds."),
            })
            .strict()
        )
        .max(100)
        .optional()
        .describe("Cookies to set. Each needs url or domain."),
      name: z.string().max(4096).optional().describe("Cookie name to delete."),
      domain: z
        .string()
        .max(4096)
        .optional()
        .describe("Domain filter for delete."),
      path: z.string().max(4096).optional().describe("Path filter for delete."),
      url: z.string().max(4096).optional().describe("URL filter for delete."),
    })
    .strict(),
  z
    .object({ action: z.literal("frames"), target: BrowserTargetSchema })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      target: BrowserTargetSchema,
      for: z
        .object({
          selector: z
            .string()
            .max(2000)
            .optional()
            .describe("CSS selector that must match an element."),
          text: z
            .string()
            .max(2000)
            .optional()
            .describe("Text that must appear in the document body."),
          hidden: z
            .boolean()
            .default(false)
            .describe(
              "Invert selector and text: wait until they no longer match."
            ),
          url: z
            .string()
            .max(2000)
            .optional()
            .describe("Substring the tab URL must contain."),
          networkIdle: z
            .boolean()
            .default(false)
            .describe("No network requests in flight for 500 ms."),
        })
        .strict()
        .describe("Conditions; all given conditions must hold."),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(60_000)
        .default(10_000)
        .describe("Wait budget in milliseconds. Default 10000."),
    })
    .strict(),
  z
    .object({
      action: z.literal("history"),
      target: BrowserTargetSchema,
      go: z
        .enum(["back", "forward", "reload"])
        .describe("Navigate the tab's history or reload the document."),
    })
    .strict(),
  z
    .object({
      action: z.literal("selectOption"),
      target: BrowserTargetSchema,
      ref: ref.describe("Observed ref of a <select> element."),
      value: z
        .string()
        .max(4096)
        .optional()
        .describe("Option value to choose."),
      label: z
        .string()
        .max(4096)
        .optional()
        .describe("Option label to choose when value is not given."),
    })
    .strict(),
  z
    .object({
      action: z.literal("upload"),
      target: BrowserTargetSchema,
      ref: ref.describe("Observed ref of an <input type=file>."),
      files: z
        .array(z.string().max(4096))
        .max(100)
        .describe("Absolute local file paths. Empty clears the input."),
    })
    .strict(),
])
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>
