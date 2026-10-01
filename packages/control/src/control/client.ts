import { ControlFault, controlInput } from "./fault.js"
import {
  RecordingHandle,
  RecordingOptionsSchema,
  RecordingReceiptSchema,
  recordingReceipt,
  type RecordingOptions,
} from "./recording.js"
import {
  ControlSelectorSchema,
  ControlReadScopeSchema,
  nameMatches,
  scopeControlNodes,
  scopeLabel,
  type ControlReadScope,
  type NameMatch,
} from "./scope.js"
import { PRESENT, presented } from "./present.js"
import { appsValue, browsersValue, tabsValue, windowsValue } from "./discovery.js"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import {
  ControlOperationSchema,
  operationLabel,
  pointerOperationSchema,
  ControlTargetSchema,
  PageTargetSchema,
  WindowControlTargetSchema,
  type NativeScreenshotOptions,
  type ControlTarget,
  type PageTarget,
} from "./contract.js"
import {
  PageObservationNodeSchema,
  PageNodeSelectorSchema,
  pageNodeLines,
  pageOutlineLine,
  selectPageNodes,
  type PageNodeSelector,
  type PageObservationNode,
  type PageNodeSelection,
} from "../browser/observation.js"
import type {
  CdpCommand,
  CdpCommandArguments,
  CdpCommandResult,
} from "../browser/protocol.js"
import type { JsonObject, JsonValue } from "../json.js"

export type ControlCall = (
  action: string,
  args: JsonObject
) => Promise<JsonValue>
export const ControlObservationSchema = z.object({
  target: ControlTargetSchema,
  observation: z.string(),
  lineage: z.string().min(1).optional(),
  nodes: z.array(PageObservationNodeSchema),
  lines: z.array(z.string()),
  scope: ControlReadScopeSchema.extend({ maxDepth: z.number().int().min(1).max(25).optional() }).optional(),
  coverage: z.object({
    complete: z.boolean(),
    omitted: z.number().nonnegative().nullable(),
    textComplete: z.boolean(),
  }),
  page: z.object({ title: z.string(), url: z.string() }).optional(),
  viewport: z
    .object({
      width: z.number(),
      height: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
      contentWidth: z.number(),
      contentHeight: z.number(),
      pagesAbove: z.number(),
      pagesBelow: z.number(),
    })
    .nullish(),
  offset: z.number().int().nonnegative().optional(),
  nextOffset: z.number().int().nullish(),
  matched: z.number().int().optional(),
})
export type ControlObservationData = z.infer<typeof ControlObservationSchema>
const selectorSchema = ControlSelectorSchema.extend({
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Zod schema composition API.
  within: ControlReadScopeSchema.shape.within.optional(),
})
const selectorHint =
  'Use {role:"button",name:"Save"}; to scope it, add within:[{role:"form",name:"Profile"}]. A string name is exact; for names with live text use name:{prefix:"Draft"}, {contains:"draft"} or a RegExp (/^Draft/). Copy the role from observe(); to search by text use observe({query}) or select({text}); CSS selectors are not supported.'
const selectionHint =
  'Use {role:"button",name:"Save",max:20}; optional keys: text (substring of role, name, value or visibleText), roles, states, refsOnly, includeAncestors. Selections take strings; for name patterns use locator({role,name:{prefix}|{contains}|/re/}).'
export type ElementSelector = z.infer<typeof selectorSchema>

// Program values may come from another realm, so RegExp is detected by tag.
const isRegExp = (value: unknown): value is RegExp =>
  Object.prototype.toString.call(value) === "[object RegExp]"
/** RegExp names become `{regex,flags}` before they cross to the host, where
 * structured cloning would turn them into empty objects. */
export function regexNames<T>(value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const name = record.name
  const within = record.within
  const match = record.match
  if (!isRegExp(name) && !Array.isArray(within) && (typeof match !== "object" || match === null)) return value
  return {
    ...record,
    ...(isRegExp(name)
      ? { name: { regex: name.source, ...(name.flags.replace(/[gyd]/g, "") ? { flags: name.flags.replace(/[gyd]/g, "") } : {}) } }
      : {}),
    ...(Array.isArray(within) ? { within: within.map(regexNames) } : {}),
    ...(typeof match === "object" && match !== null ? { match: regexNames(match) } : {}),
  } as T
}
/** Text a name pattern can search by, or undefined for a regular expression. */
function nameText(name: NameMatch): string | undefined {
  if (typeof name === "string") return name
  if ("prefix" in name) return name.prefix
  if ("contains" in name) return name.contains
  return undefined
}
/** Same-role nodes that share a word with the wanted name, then any of that role. */
function nearNames(nodes: readonly PageObservationNode[], role: string, name: NameMatch) {
  const words = (nameText(name) ?? "").toLocaleLowerCase().split(/\W+/).filter((word) => word.length > 1)
  const sameRole = nodes.filter((node) => node.role === role)
  const sharing = sameRole.filter((node) => words.some((word) => (node.name ?? "").toLocaleLowerCase().includes(word)))
  return [...new Set([...sharing, ...sameRole])].slice(0, 6).map((node) => ({ ref: node.ref, name: node.name?.slice(0, 120) }))
}

/** The CSS and text selector spellings callers reach for instead of `{role,name}`. */
const textSelectorSchema = z.union([
  z.string(),
  z.object({ css: z.string() }).transform((input) => input.css),
  z.object({ selector: z.string() }).transform((input) => input.selector),
])

/** Quotes a CSS or text selector back to the caller: the stock example alone
 * does not show that accessible names can differ from visible labels. */
export function controlSelector(value: JsonValue | ElementSelector): ElementSelector {
  const text = textSelectorSchema.safeParse(value).data
  if (text === undefined)
    return controlInput(selectorSchema.safeParse(regexNames(value)), "selector", selectorHint)
  const quoted = /["'](.{1,60}?)["']/.exec(text)?.[1] ?? /^text=(.{1,60})$/.exec(text)?.[1]
  throw new ControlFault(
    "invalid-request",
    `${JSON.stringify(text.slice(0, 80))} is a CSS or text selector; selectors are {role,name,within?} copied from an observation. Observe with ${quoted ? `{query:${JSON.stringify(quoted)},interactive:true}` : "{interactive:true}"} and copy the matching node's role and exact name. A node's visibleText is its label when that differs from its name, and names match the name, not the label. Nothing was dispatched.`,
    "not-dispatched"
  )
}
const expectationSchema = selectorSchema
  .extend({
    value: z.string().optional(),
    states: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()])
      )
      .optional(),
    absent: z.boolean().default(false),
  })
  .strict()
  .refine(
    (x) => !x.absent || (x.value === undefined && x.states === undefined),
    "Absence cannot have a value or states"
  )
export type ElementExpectation = z.input<typeof expectationSchema>
/** What a tab can wait for without naming an element. */
const pageConditionSchema = z
  .object({
    text: z.string().optional(),
    selector: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    hidden: z.boolean().optional(),
    networkIdle: z.boolean().optional(),
  })
  .strict()
  .refine((condition) => [condition.text, condition.selector, condition.url, condition.title, condition.networkIdle].some((value) => value !== undefined && value !== false))
export type PageCondition = z.input<typeof pageConditionSchema>
export type PageWaitResult = { satisfied: boolean; elapsedMs: number }

export interface ControlExpectationResult {
  status: "matched"
  target: ControlTarget
  observation: string
  expectation: z.output<typeof expectationSchema>
  evidence: PageObservationNode | null
  coverage: ControlObservationData["coverage"]
}

export interface ControlSelection extends PageNodeSelection {
  target: ControlTarget
  observation: string
  lines: string[]
  coverage: ControlObservationData["coverage"]
  toJSON(): Omit<ControlSelection, "nodes" | "toJSON">
}

const spaced = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase()

/** Explains a miss where the requested name is only what the control shows or
 * part of its name; string names stay exact, so the fix is to use the listed
 * accessible name. */
function visibleTextHint(nodes: readonly PageObservationNode[], role: string, name: NameMatch) {
  if (typeof name !== "string" || !spaced(name)) return ""
  const wanted = spaced(name)
  const shown = nodes
    .filter(
      (node) =>
        node.role === role &&
        ((node.visibleText !== undefined && spaced(node.visibleText) === wanted) || spaced(node.name ?? "").includes(wanted))
    )
    .slice(0, 3)
  if (!shown.length) return ""
  const named = shown.map((node) => `${role} ${JSON.stringify(node.name ?? "")}${node.ref ? ` (${node.ref})` : ""}`).join(", ")
  const relation = shown.some((node) => node.visibleText !== undefined && spaced(node.visibleText) === wanted)
    ? "the visible text"
    : "part of the name"
  return `${JSON.stringify(name)} is ${relation} of ${named}. A string name matches the accessible name exactly, so use locator({role:${JSON.stringify(role)},name:${JSON.stringify(shown[0]!.name ?? "")}}) or name:{contains:${JSON.stringify(name)}}; nothing was dispatched.`
}

const inspectionSchema = z.looseObject({
  tag: z.string(),
  text: z.string(),
  textLength: z.number().optional(),
  attributes: z.record(z.string(), z.string()),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  visible: z.boolean(),
  inViewport: z.boolean(),
  styles: z.record(z.string(), z.string()).optional(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
})

/** What was asked for first: the element, its place, then requested styles.
 * Attributes print when requested or when no styles were; the default set
 * repeats inline styles. */
function inspectionText(
  inspection: z.infer<typeof inspectionSchema>,
  options: { attributes?: string[]; styles?: string[] }
): string {
  const { box } = inspection
  const facts = [
    `${Math.round(box.width)}×${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}`,
    inspection.visible ? (inspection.inViewport ? "visible" : "visible, off-screen") : "hidden",
    ...(inspection.value !== undefined ? [`value=${JSON.stringify(inspection.value)}`] : []),
    ...(inspection.checked !== undefined ? [inspection.checked ? "checked" : "unchecked"] : []),
    ...(inspection.disabled ? ["disabled"] : []),
    ...(inspection.textLength ? [`text is ${inspection.textLength} chars; .text holds the first 2000`] : []),
  ]
  const lines = [`${inspection.tag} ${JSON.stringify(inspection.text)} · ${facts.join(" · ")}`]
  const styles = Object.entries(inspection.styles ?? {})
  if (styles.length) lines.push(`styles ${styles.map(([name, value]) => `${name}: ${value}`).join("; ")}`)
  const attributes = Object.entries(inspection.attributes)
  if (attributes.length && (options.attributes || !options.styles?.length))
    lines.push(`attributes ${attributes.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" ")}`)
  return lines.join("\n")
}

/** The header an agent reads above an observation's rows: where the page is,
 * how much of it the rows cover and how to read the rest. */
function observationHeader(data: ControlObservationData, returned: number): string[] {
  const head: string[] = []
  const viewport = data.viewport
  const place = viewport
    ? ` · ${viewport.width}×${viewport.height} at y=${Math.round(viewport.scrollY)} of ${Math.round(viewport.contentHeight)}${viewport.pagesBelow ? `, ${viewport.pagesBelow} pages below` : ""}`
    : ""
  if (data.page) {
    // A data: or signed URL can run to thousands of characters on every read;
    // the value keeps it whole.
    const { url } = data.page
    const shown = url.length > 200 ? `${url.slice(0, 160)}… (${url.length} chars in .page.url)` : url
    head.push(`page ${JSON.stringify(data.page.title)} ${shown}${place}`)
  }
  const within = data.scope?.within ?? []
  if (within.length || data.scope?.match)
    head.push(`scope ${[...within.map(scopeLabel), ...(data.scope?.match ? [`match ${data.scope.match.role} ${JSON.stringify(data.scope.match.name)}`] : [])].join(" › ")}`)
  const first = (data.offset ?? 0) + 1
  const rows = `rows ${first}–${first + returned - 1} of ${data.matched ?? "more"}`
  if (data.nextOffset != null)
    head.push(`${rows}; observe({offset:${data.nextOffset}}) reads on, or narrow with within, match or query`)
  else if (data.offset) head.push(`${rows}, the last`)
  else if (!data.coverage.complete && data.coverage.omitted)
    head.push(`${data.coverage.omitted} more elements not shown; narrow with within, match or maxDepth`)
  else if (!data.coverage.complete) head.push("filtered read: absence here proves nothing")
  if (!data.coverage.textComplete) head.push("some long text is shortened; inspect(ref) reads it whole")
  if (!returned) head.push("no elements")
  return head
}

/** Structured evidence stays local; returning an observation emits its compact view once. */
export class ControlObservation {
  readonly data: ControlObservationData
  constructor(value: JsonValue | ControlObservationData) {
    this.data = ControlObservationSchema.parse(value)
  }
  get page() {
    return this.data.page
  }
  get viewport() {
    return this.data.viewport ?? undefined
  }
  get nextOffset() {
    return this.data.nextOffset ?? undefined
  }
  [PRESENT]() {
    return [...observationHeader(this.data, this.nodes.length), ...this.lines].join("\n")
  }
  get target() {
    return this.data.target
  }
  get observation() {
    return this.data.observation
  }
  get nodes(): PageObservationNode[] {
    return this.data.nodes
  }
  get lines() {
    return this.data.lines
  }
  get coverage() {
    return this.data.coverage
  }
  get(selector: ElementSelector): PageObservationNode {
    const { role, name, within } = controlSelector(selector)
    const matches = scopeControlNodes(this.nodes, {
      within,
      match: { role, name },
    })
    const shown = matches.length ? "" : visibleTextHint(this.nodes, role, name)
    if (matches.length !== 1)
      throw new ControlFault(
        matches.length ? "target-ambiguous" : "target-not-found",
        `Expected one observed ${role} ${JSON.stringify(name)}, found ${matches.length}. ${
          shown ||
          (matches.length
            ? `Matches: ${JSON.stringify(matches.slice(0, 5).map((node) => ({ ref: node.ref, name: node.name?.slice(0, 120), depth: node.depth })))}. Scope it with within:[{role,name}] or use a ref; nothing was dispatched.`
            : `Observed ${role} names: ${JSON.stringify(nearNames(this.nodes, role, name))}. Copy one, or match live text with name:{prefix}, {contains} or a RegExp; nothing was dispatched.`)
        }`,
        "not-dispatched"
      )
    return matches[0]!
  }
  select(selector: PageNodeSelector): ControlSelection {
    const selection = selectPageNodes(
      { nodes: this.nodes },
      controlInput(
        PageNodeSelectorSchema.safeParse(selector),
        "selection",
        selectionHint
      )
    )
    const { nodes, ...counts } = selection
    const compact = {
      ...counts,
      target: this.target,
      observation: this.observation,
      lines: pageNodeLines(nodes),
      coverage: this.coverage,
    }
    return presented(
      { ...compact, nodes, toJSON: () => compact },
      () =>
        [
          `selected ${counts.returned - counts.context} of ${counts.matched}${counts.context ? `, with ${counts.context} ancestors for context` : ""}${counts.omitted ? `; ${counts.omitted} more match, raise max` : ""}`,
          ...compact.lines,
        ].join("\n")
    )
  }
  diff(previous: ControlObservation) {
    if (JSON.stringify(previous.target) !== JSON.stringify(this.target))
      throw new Error("Cannot diff different targets")
    const full = (reason: string) => ({
      kind: "full" as const,
      reason,
      ...this.toJSON(),
    })
    const scope = (view: ControlObservation) =>
      ControlReadScopeSchema.parse(view.data.scope ?? {})
    if (JSON.stringify(scope(previous)) !== JSON.stringify(scope(this)))
      return full("scope-changed")
    if (!this.data.lineage || !previous.data.lineage)
      return full("lineage-unavailable")
    if (this.data.lineage !== previous.data.lineage)
      return full("lineage-changed")
    if (
      !this.coverage.complete ||
      !previous.coverage.complete ||
      !this.coverage.textComplete ||
      !previous.coverage.textComplete
    )
      return full("incomplete-observation")
    // Compare structured values and ancestry, not the display's shortened text.
    // Order changes require a full view: a multiset cannot describe reordering.
    const key = (node: ControlObservationData["nodes"][number]) =>
      JSON.stringify(
        Object.entries(node)
          .filter(([name]) => name !== "ref")
          .sort(([a], [b]) => a.localeCompare(b))
      )
    const current = this.nodes.map(key)
    const before = previous.nodes.map(key)
    const subtract = (left: string[], right: string[]) => {
      const counts = new Map<string, number>()
      for (const item of right) counts.set(item, (counts.get(item) ?? 0) + 1)
      return left.flatMap((item, index) => {
        const count = counts.get(item) ?? 0
        if (!count) return [index]
        counts.set(item, count - 1)
        return []
      })
    }
    const added = subtract(current, before)
    const removed = subtract(before, current)
    if (
      !added.length &&
      !removed.length &&
      JSON.stringify(current) !== JSON.stringify(before)
    )
      return full("order-changed")
    const result = {
      kind: "delta" as const,
      target: this.target,
      observation: this.observation,
      lineage: this.data.lineage,
      scope: this.data.scope,
      coverage: this.coverage,
      added: pageNodeLines(added.map((index) => this.nodes[index]!)),
      removed: pageNodeLines(
        removed.map((index) => {
          const node = { ...previous.nodes[index]! }
          delete node.ref
          return node
        })
      ),
    }
    if (
      added.length + removed.length > 120 ||
      JSON.stringify(result).length > 16_000
    )
      return full("change-budget-exceeded")
    return result
  }
  toJSON() {
    return {
      ...(this.data.page ? { page: this.data.page } : {}),
      lines: this.lines,
      coverage: this.coverage,
      ...(this.data.nextOffset != null ? { nextOffset: this.data.nextOffset } : {}),
    }
  }
}

/** Quiet notifications are timing information, not action verification. */
export const NativeSettlingSchema = z
  .object({
    status: z.enum(["events_quiet", "deadline", "unavailable"]),
    scope: z.literal("process_notifications"),
    elapsed_ms: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    subscriptions: z.number().int().nonnegative(),
  })
  .strict()
export type NativeSettling = z.infer<typeof NativeSettlingSchema>

/** A bounded native observation, not a guarantee of continuous focus isolation. */
export const NativeFocusChangeSchema = z
  .object({
    previous_pid: z.number().int().positive(),
    current_pid: z.number().int().positive().nullable(),
    restoration_attempted: z.boolean(),
    input_activity_observed: z.boolean(),
  })
  .strict()
export type NativeFocusChange = z.infer<typeof NativeFocusChangeSchema>

export const ExecutionReceiptSchema = z.object({
  status: z.literal("dispatched"),
  actionId: z.string(),
  route: z.string(),
  delivery: z.enum(["background", "foreground", "none"]),
  verification: z.literal("not-requested"),
  settling: NativeSettlingSchema.optional(),
  focus_change: NativeFocusChangeSchema.optional(),
  guard: z.record(z.string(), z.json()),
  result: z.json().optional(),
})
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>

/** What was sent and how; the rest of the receipt prints only when unusual. */
function receiptText(operation: z.input<typeof ControlOperationSchema>, receipt: ExecutionReceipt): string {
  const parts = [`dispatched ${operationLabel(operation)} · ${receipt.route} · ${receipt.delivery}`]
  if (JSON.stringify(receipt.guard) !== '{"status":"settled"}') parts.push(`guard ${JSON.stringify(receipt.guard)}`)
  if (receipt.settling) parts.push(`settling ${receipt.settling.status} after ${receipt.settling.elapsed_ms} ms`)
  if (receipt.focus_change)
    parts.push(`focus moved from pid ${receipt.focus_change.previous_pid} to ${receipt.focus_change.current_pid ?? "none"}${receipt.focus_change.restoration_attempted ? ", restore attempted" : ""}`)
  if (receipt.result !== undefined && receipt.result !== null) parts.push(`result ${JSON.stringify(receipt.result)}`)
  return parts.join(" · ")
}

const ShotSchema = z.looseObject({
  view: z.string(),
  mimeType: z.string(),
  data: z.string(),
  coordinates: z
    .looseObject({
      units: z.string().optional(),
      imageWidth: z.number().optional(),
      imageHeight: z.number().optional(),
      imageScaleX: z.number().optional(),
      imageScaleY: z.number().optional(),
      pageX: z.number().optional(),
      pageY: z.number().optional(),
      viewportPageX: z.number().optional(),
      viewportPageY: z.number().optional(),
    })
    .optional(),
})
/** A screenshot prints as its geometry and view token, never its pixels. */
function screenshotValue(value: JsonValue) {
  const shot = ShotSchema.safeParse(value)
  if (!shot.success || typeof value !== "object" || value === null) return value
  return presented(value, () => {
    const { coordinates: c, mimeType, view, data } = shot.data
    const size = c?.imageWidth && c.imageHeight ? `${c.imageWidth}×${c.imageHeight} ` : ""
    const offsetX = (c?.pageX ?? 0) - (c?.viewportPageX ?? 0)
    const offsetY = (c?.pageY ?? 0) - (c?.viewportPageY ?? 0)
    const mapping =
      c && ((c.imageScaleX ?? 1) !== 1 || (c.imageScaleY ?? 1) !== 1 || offsetX || offsetY)
        ? `click x = imageX/${c.imageScaleX ?? 1}${offsetX ? ` + ${offsetX}` : ""}, y = imageY/${c.imageScaleY ?? 1}${offsetY ? ` + ${offsetY}` : ""}`
        : "image pixels are click coordinates"
    return `screenshot ${mimeType} ${size}(${Math.round((data.length * 3) / 4 / 1024)} KB) view ${view} · ${mapping} with {x,y,view:shot.view} · emitImage(shot) shows it`
  })
}
export type ObserveOptions = ControlReadScope & {
  query?: string
  interactive?: boolean
  max?: number
}
export type NativeObserveOptions = ObserveOptions & { maxDepth?: number }
const pointSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    view: z.string().min(1),
  })
  .strict()
const clickOptionsSchema = pointerOperationSchema.omit({ kind: true, at: true })
export type Point = z.infer<typeof pointSchema>
function pointerAt(at: string | Point) {
  return typeof at === "string"
    ? { ref: at }
    : controlInput(
        pointSchema.safeParse(at),
        "point",
        "Use an observed ref string or {x:100,y:80,view:shot.view} from this tab’s latest screenshot."
      )
}

export class ControlHandle {
  readonly target: ControlTarget
  constructor(
    protected readonly call: ControlCall,
    target: ControlTarget
  ) {
    this.target = Object.freeze(
      controlInput(
        ControlTargetSchema.safeParse(target),
        "target",
        "Use an exact target returned by discovery/open/claim; do not guess a lease or window ID."
      )
    )
  }
  locator(selector: ElementSelector) {
    return new ControlLocator(
      this,
      controlSelector(selector)
    )
  }
  async observe(options: ObserveOptions = {}) {
    return new ControlObservation(
      await this.call("observe", { ...regexNames(options), target: this.target })
    )
  }
  async record(options: RecordingOptions = {}) {
    const receipt = recordingReceipt(
      RecordingReceiptSchema.parse(
        await this.call("recording", {
          operation: "start",
          target: this.target,
          options: controlInput(
            RecordingOptionsSchema.safeParse(options),
            "recording options",
            "Use {directory?,name?,cursor?,maxDurationMs?,maxSide?,fps?}. Read handle.capabilities() for this target’s frame-rate limit."
          ),
        })
      ),
      this.target
    )
    return new RecordingHandle(this.call, receipt)
  }
  async recording(id: string) {
    const exact = controlInput(z.string().min(1).safeParse(id), "recording ID", "Copy the id from the recording receipt; this reads an existing recording and never starts one.")
    const receipt = recordingReceipt(
      RecordingReceiptSchema.parse(await this.call("recording", { operation: "status", target: this.target, id: exact })),
      this.target,
      exact
    )
    return new RecordingHandle(this.call, receipt)
  }
  capabilities() {
    return this.call("capabilities", { target: this.target })
  }
  protected async perform(
    operation: z.input<typeof ControlOperationSchema>
  ): Promise<ExecutionReceipt> {
    const receipt = ExecutionReceiptSchema.parse(
      await this.call("dispatch", {
        target: this.target,
        operation: controlInput(
          ControlOperationSchema.safeParse(operation),
          "operation",
          "Use setValue(ref,text), click(ref), pressKey(key,{modifiers?}) or scroll({deltaX?,deltaY?,at?}); copy refs from this target’s latest observation."
        ),
      })
    )
    return presented(receipt, () => receiptText(operation, receipt))
  }
  setValue(ref: string, value: string) {
    return this.perform({ kind: "set-text", ref, text: value })
  }
  click(
    at: string | Point,
    options: { button?: "left" | "right" | "middle"; count?: number } = {}
  ) {
    const click = controlInput(
      clickOptionsSchema.safeParse(options),
      "click options",
      'Use {button:"right",count:1}; button is left/right/middle, count is 1–3.'
    )
    const reference = z.string().safeParse(at)
    if (reference.success && click.button === "left" && click.count === 1)
      return this.activate(reference.data)
    return this.perform({
      kind: "pointer",
      at: reference.success
        ? { ref: reference.data }
        : controlInput(
            pointSchema.safeParse(at),
            "click point",
            "Use an observed ref string or {x:100,y:80,view:shot.view} from this target’s latest screenshot."
          ),
      ...click,
    })
  }
  activate(ref: string) {
    return this.perform({ kind: "activate", ref })
  }
  pressKey(key: string, options: { modifiers?: string[]; ref?: string } = {}) {
    return this.perform({ kind: "press-key", key, ...options })
  }
  scroll(delta: {
    deltaX?: number
    deltaY?: number
    at?: { ref: string } | Point
  }) {
    return this.perform({ kind: "scroll", ...delta })
  }
  selectOption(ref: string, option: { value: string } | { label: string }) {
    return this.perform({ kind: "select-option", ref, ...option })
  }
  events(options: { after?: number; limit?: number } = {}) {
    return this.call("events", { target: this.target, ...options })
  }
  expect(expectation: ElementExpectation, options?: { timeoutMs?: number; everyMs?: number }): Promise<ControlExpectationResult>
  expect(condition: PageCondition, options?: { timeoutMs?: number }): Promise<PageWaitResult>
  async expect(
    expectation: ElementExpectation | PageCondition,
    options: { timeoutMs?: number; everyMs?: number } = {}
  ): Promise<ControlExpectationResult | PageWaitResult> {
    const page = pageConditionSchema.safeParse(expectation)
    if (page.success && this instanceof TabHandle)
      return this.waitFor(page.data, { timeoutMs: Math.max(100, options.timeoutMs ?? 5000) })
    const wanted = controlInput(
      expectationSchema.safeParse(regexNames(expectation)),
      "expectation",
      `Use {role:"textbox",name:"Name",value:"Ada"}; optional within, states, absent.${this instanceof TabHandle ? " A page condition is {url?,title?,text?,selector?,hidden?} on its own, without role or name." : ""}`
    )
    const timing = controlInput(
      z
        .object({
          timeoutMs: z.number().int().min(0).max(55_000).default(5000),
          everyMs: z.number().int().min(20).max(2000).default(100),
        })
        .strict()
        .safeParse(options),
      "assertion timing",
      "Use {timeoutMs:5000,everyMs:100}; timeoutMs is 0–55000 and everyMs is 20–2000."
    )
    const deadline = Date.now() + timing.timeoutMs
    for (;;) {
      const view = await this.observe({
        max: 2,
        within: wanted.within,
        match: { role: wanted.role, name: wanted.name },
      })
      const matches = view.nodes.filter(
        (node) => node.role === wanted.role && nameMatches(node.name, wanted.name)
      )
      if (matches.length > 1)
        throw new ControlFault(
          "target-ambiguous",
          `Assertion ambiguous: ${matches.length} observed ${wanted.role} ${JSON.stringify(wanted.name)}. Scope it with within:[{role,name}].`,
          "not-dispatched"
        )
      const node = matches[0]
      if (
        node?.valueExact === false &&
        (wanted.value !== undefined || wanted.states?.value !== undefined)
      )
        throw new ControlFault(
          "unsupported",
          "Exact value unavailable: this native driver returned display-normalized text. An exact-value-capable driver is required; no input was replayed.",
          "not-dispatched"
        )
      const matched = wanted.absent
        ? !node && view.coverage.complete && view.coverage.textComplete
        : node !== undefined &&
          view.coverage.textComplete &&
          (wanted.value === undefined ||
            (node.valueExact !== false && node.value === wanted.value)) &&
          Object.entries(wanted.states ?? {}).every(
            ([key, value]) => node[key] === value
          )
      if (matched)
        return presented(
          {
            status: "matched" as const,
            target: this.target,
            observation: view.observation,
            expectation: wanted,
            evidence: node ?? null,
            coverage: view.coverage,
          },
          () =>
            wanted.absent
              ? `matched: no ${wanted.role} ${JSON.stringify(wanted.name)}`
              : `matched ${node ? pageOutlineLine(node) : wanted.role}`
        )
      if (Date.now() >= deadline)
        throw new ControlFault(
          "assertion-failed",
          `Assertion not established: ${JSON.stringify(wanted)}; ${JSON.stringify(view)}`,
          "not-dispatched"
        )
      await delay(Math.min(timing.everyMs, Math.max(1, deadline - Date.now())))
    }
  }
  toJSON() {
    return this.target
  }
}

/** Keeps semantic intent, never an expiring reference. Each action reads once,
 * resolves strictly and dispatches once; failures are never retried. */
export class ControlLocator {
  constructor(
    private readonly handle: ControlHandle,
    readonly selector: ElementSelector
  ) {}
  locator(selector: ElementSelector) {
    const next = controlSelector(selector)
    return new ControlLocator(this.handle, {
      ...next,
      within: [
        ...(this.selector.within ?? []),
        { role: this.selector.role, name: this.selector.name },
        ...(next.within ?? []),
      ],
    })
  }
  read(options: { max?: number } = {}) {
    return this.handle.observe({
      ...options,
      within: [
        ...(this.selector.within ?? []),
        { role: this.selector.role, name: this.selector.name },
      ],
    })
  }
  private async resolve() {
    const view = await this.handle.observe({
      within: this.selector.within,
      match: { role: this.selector.role, name: this.selector.name },
      max: 6,
    })
    if (!view.coverage.complete || !view.coverage.textComplete)
      throw new ControlFault(
        "incomplete-observation",
        "Locator coverage is incomplete. Narrow its scope with within:[{role,name}]; nothing was dispatched.",
        "not-dispatched"
      )
    const { role, name, within } = this.selector
    if (!view.nodes.some((node) => node.role === role && nameMatches(node.name, name))) {
      const query = nameText(name)
      const nearby = await this.handle.observe({ within, ...(query && this.handle.target.kind === "page" ? { query } : {}), interactive: true, max: 40 })
      const shown = visibleTextHint(nearby.nodes, role, name)
      throw new ControlFault(
        "target-not-found",
        `No ${role} is named ${JSON.stringify(name)}. ${shown || `Observed ${role} names: ${JSON.stringify(nearNames(nearby.nodes, role, name))}. Copy one, or match live text with name:{prefix}, {contains} or a RegExp; nothing was dispatched.`}`,
        "not-dispatched"
      )
    }
    const node = view.get({ role, name })
    if (!node.ref)
      throw new ControlFault(
        "target-not-actionable",
        "The matched element has no actionable reference; observe an interactive control instead. Nothing was dispatched.",
        "not-dispatched"
      )
    return node.ref
  }
  async click(
    options: { button?: "left" | "right" | "middle"; count?: number } = {}
  ) {
    return this.handle.click(await this.resolve(), options)
  }
  async setValue(value: string) {
    return this.handle.setValue(await this.resolve(), value)
  }
  async pressKey(key: string, options: { modifiers?: string[] } = {}) {
    return this.handle.pressKey(key, { ...options, ref: await this.resolve() })
  }
  async selectOption(option: { value: string } | { label: string }) {
    return this.handle.selectOption(await this.resolve(), option)
  }
  async screenshot(
    options: {
      format?: "png" | "jpeg"
      quality?: number
      maxSide?: number
    } = {}
  ) {
    if (!(this.handle instanceof TabHandle))
      throw new ControlFault(
        "unsupported",
        "Element screenshots currently require a browser tab. Use window.screenshot() for the native window; nothing was captured.",
        "not-dispatched"
      )
    return this.handle.screenshot({ ...options, ref: await this.resolve() })
  }
  private tab(verb: string) {
    if (!(this.handle instanceof TabHandle))
      throw new ControlFault(
        "unsupported",
        `${verb} currently requires a browser tab; native windows support click, setValue, pressKey and scroll. Nothing was dispatched.`,
        "not-dispatched"
      )
    return this.handle
  }
  async hover() {
    const tab = this.tab("hover")
    return tab.hover(await this.resolve())
  }
  /** Drags this element onto another locator, an observed ref or a point.
   * Two locators resolve from one observation, since each observation
   * replaces the tab's refs. */
  async dragTo(target: ControlLocator | string | Point, options: { steps?: number; modifiers?: string[] } = {}) {
    const tab = this.tab("dragTo")
    if (!(target instanceof ControlLocator)) return tab.drag(await this.resolve(), target, options)
    const view = await tab.observe({ max: 1000 })
    const ref = (locator: ControlLocator) => {
      const node = view.get(locator.selector)
      if (!node.ref)
        throw new ControlFault("target-not-actionable", "The matched element has no actionable reference; nothing was dispatched.", "not-dispatched")
      return node.ref
    }
    return tab.drag(ref(this), ref(target), options)
  }
  async inspect(options: { attributes?: string[]; styles?: string[] } = {}) {
    const tab = this.tab("inspect")
    return tab.inspect(await this.resolve(), options)
  }
  async scrollIntoView() {
    const tab = this.tab("scrollIntoView")
    return tab.scrollIntoView(await this.resolve())
  }
  expect(
    expectation: Omit<ElementExpectation, "role" | "name" | "within">,
    options: { timeoutMs?: number; everyMs?: number } = {}
  ): Promise<ControlExpectationResult> {
    return this.handle.expect({ ...expectation, ...this.selector }, options)
  }
  toJSON() {
    return { target: this.handle.target, selector: this.selector }
  }
}

export class WindowHandle extends ControlHandle {
  override observe(options: NativeObserveOptions = {}) {
    return super.observe(options)
  }
  async screenshot(options: NativeScreenshotOptions = {}) {
    return screenshotValue(
      await this.call("capture", {
        target: this.target,
        options: { ...options },
      })
    )
  }
  private nativeTarget() {
    const target = WindowControlTargetSchema.parse(this.target)
    return { pid: target.pid, window_id: target.window_id }
  }
  raw(name: string, args: JsonObject = {}) {
    return this.call("native", {
      name,
      args: { ...args, ...this.nativeTarget() },
    })
  }
}

export class TabHandle extends ControlHandle {
  private pageTarget() {
    const { kind: _kind, ...target } = PageTargetSchema.parse(this.target)
    return target
  }
  raw(name: string, args: JsonObject = {}) {
    return this.call("page", {
      name,
      args: { ...args, target: this.pageTarget() },
    })
  }
  navigate(
    url: string,
    options: {
      waitUntil?: "load" | "domcontentloaded" | "commit"
      timeoutMs?: number
    } = {}
  ) {
    return this.raw("navigate", { url, ...options })
  }
  async screenshot(options: JsonObject = {}) {
    return screenshotValue(await this.call("capture", { target: this.target, options }))
  }
  upload(ref: string, files: string[]) {
    return this.raw("upload", { ref, files })
  }
  /** Runs an expression, or a function called with JSON arguments, in the
   * page and returns its JSON value. Functions cannot see program variables. */
  async evaluate(script: string | ((...args: never[]) => unknown), ...args: JsonValue[]): Promise<JsonValue | undefined> {
    if (typeof script === "string" && args.length)
      throw new ControlFault("invalid-request", "Arguments need a function: tab.evaluate((a, b) => a + b, 1, 2). Nothing was dispatched.", "not-dispatched")
    const expression = typeof script === "function" ? `(${script.toString()})(...${JSON.stringify(args)})` : script
    const result = await this.raw("evaluate", { expression })
    const remote = z
      .object({ result: z.object({ type: z.string(), value: z.json().optional(), description: z.string().optional() }) })
      .safeParse(result)
    if (!remote.success) return result
    if (remote.data.result.value !== undefined) return remote.data.result.value
    return remote.data.result.type === "undefined" ? undefined : remote.data.result.description ?? null
  }
  /** Reads an observed element's tag, text, attributes, box and chosen
   * computed styles without changing the page. */
  async inspect(ref: string, options: { attributes?: string[]; styles?: string[] } = {}) {
    const value = await this.raw("inspect", { ref, ...options })
    const inspection = inspectionSchema.safeParse(value)
    if (!inspection.success || typeof value !== "object" || value === null || Array.isArray(value)) return value
    return presented(value, () => inspectionText(inspection.data, options))
  }
  private async dispatched(action: string, args: JsonObject) {
    const result = await this.raw(action, args)
    const subject = [args.ref, ...[args.at, args.from, args.to].map((at) => (typeof at === "object" && at !== null && "ref" in at ? at.ref : at && JSON.stringify(at)))]
    return presented(
      { status: "dispatched" as const, action, verification: "not-requested" as const, result },
      () => `dispatched ${[action, ...subject.filter(Boolean)].join(" ")}${result !== null && result !== undefined ? ` · result ${JSON.stringify(result)}` : ""}`
    )
  }
  hover(at: string | Point) {
    return this.dispatched("hover", { at: pointerAt(at) })
  }
  /** Presses at `from`, moves in steps and releases at `to`; handles native
   * HTML5 drag and drop as well as pointer-event drags. */
  drag(from: string | Point, to: string | Point, options: { steps?: number; modifiers?: string[] } = {}) {
    return this.dispatched("drag", { from: pointerAt(from), to: pointerAt(to), ...options })
  }
  scrollIntoView(ref: string) {
    return this.dispatched("scrollIntoView", { ref })
  }
  /** Waits until every given condition holds; throws assertion-failed at the
   * deadline. Text is a substring of the page's visible text. */
  async waitFor(
    condition: PageCondition,
    options: { timeoutMs?: number } = {}
  ) {
    const timeoutMs = controlInput(
      z.number().int().min(100).max(55_000).default(10_000).safeParse(options.timeoutMs),
      "wait timeout",
      "Use {timeoutMs:10000}; 100–55000."
    )
    const wanted = controlInput(
      pageConditionSchema.safeParse(condition),
      "page condition",
      'Use {url:"/done"}, {title:"Inbox"}, {text:"Saved"} or {selector:".toast",hidden:true}; text, url and title are substrings.'
    )
    const result = z
      .object({ satisfied: z.boolean(), elapsedMs: z.number() })
      .parse(await this.raw("wait", { for: { ...wanted }, timeoutMs }))
    if (!result.satisfied)
      throw new ControlFault(
        "assertion-failed",
        `Not established within ${timeoutMs} ms: ${JSON.stringify(condition)}. Observe or screenshot to see the page's state; nothing was dispatched.`,
        "not-dispatched"
      )
    return presented(result, () => `satisfied ${JSON.stringify(condition)} after ${result.elapsedMs} ms`)
  }
  dialog(
    options: {
      auto?: "ask" | "accept" | "dismiss"
      respond?: "accept" | "dismiss"
      promptText?: string
    } = {}
  ) {
    return this.raw("dialog", options)
  }
  async children() {
    return z
      .object({
        children: z.array(
          z.object({
            browser: z.string(),
            tab: z.string(),
            title: z.string(),
            url: z.string(),
          })
        ),
        note: z.string(),
      })
      .parse(await this.raw("children"))
  }
  retain(name: string) {
    return this.raw("retain", { name })
  }
  downloadStatus(id: number, options: { timeoutMs?: number } = {}) {
    return this.raw("downloadStatus", { id, ...options })
  }
  download(options: {
    directory: string
    ref?: string
    url?: string
    timeoutMs?: number
  }) {
    const { ref, ...rest } = options
    const args: JsonObject = { ...rest }
    if (ref) args.at = { ref }
    return this.raw("download", args)
  }
  release() {
    return this.raw("release")
  }
  close() {
    return this.raw("close")
  }
  async cdp<Method extends CdpCommand>(
    method: Method,
    ...args: CdpCommandArguments<Method>
  ): Promise<CdpCommandResult<Method>> {
    const result = await this.raw("cdp", {
      method,
      params: controlInput(
        z.record(z.string(), z.json()).safeParse(args[0] ?? {}),
        "CDP parameters",
        "Use a JSON object matching help({domain,method}); functions and undefined are not protocol values."
      ),
    })
    // SAFETY: The pinned method maps to this result; the host validates the command and JSON wire data.
    return result as CdpCommandResult<Method>
  }
}

export class AppHandle {
  readonly pid: number
  constructor(
    private readonly call: ControlCall,
    pid: number
  ) {
    this.pid = controlInput(
      z.number().int().positive().safeParse(pid),
      "application PID",
      "Use a numeric pid from control.apps(); then await control.app({pid}).windows()."
    )
  }
  async windows() {
    return windowsValue(await this.call("targets", { kind: "windows", pid: this.pid }))
  }
  window(windowId: number) {
    return new WindowHandle(
      this.call,
      controlInput(
        WindowControlTargetSchema.safeParse({
          kind: "window",
          pid: this.pid,
          window_id: windowId,
        }),
        "window ID",
        "Use a numeric window_id from await control.windows(pid)."
      )
    )
  }
  toJSON() {
    return { pid: this.pid }
  }
}

export type OpenTabOptions = {
  browser?: string
  name?: string
  url?: string
  background?: boolean
  disposition?: "tab" | "window"
  lifetime?: "task" | "persistent"
  context?: "profile" | "isolated"
}
/** Creation succeeded but navigation did not. The exact tab remains owned by this task. */
export class TabNavigationError extends Error {
  constructor(
    readonly target: PageTarget,
    readonly navigation: JsonValue,
    message: string
  ) {
    super(
      `Tab created, but navigation failed: ${message}. Inspect this exact tab with control.tab(error.target); do not repeat openTab. Target: ${JSON.stringify(target)}`
    )
    this.name = "TabNavigationError"
  }
}
export function controlClient(call: ControlCall) {
  const bindPage = (value: JsonValue) => {
    const target = z
      .object({
        browser: z.string(),
        tab: z.string(),
        generation: z.string(),
        lease: z.string(),
      })
      .parse(value)
    return new TabHandle(call, { kind: "page", ...target })
  }
  return Object.freeze({
    status: () => call("status", {}),
    help: (options: { topic?: "discovery" | "connection" | "handles" | "actions" | "observations" | "assertions" | "recording" | "page" | "native" | "output" | "examples"; tool?: string; domain?: string; method?: string } = {}) => call("help", { ...options }),
    app: (target: { pid: number }) => new AppHandle(call, target.pid),
    window: (target: { pid: number; window_id: number }) =>
      new WindowHandle(
        call,
        controlInput(
          WindowControlTargetSchema.safeParse({ kind: "window", ...target }),
          "window target",
          "Use control.window({pid,window_id}) with numeric IDs from control.windows(pid)."
        )
      ),
    tab: (target: PageTarget | { target: PageTarget }) => {
      const receipt = z.object({ target: z.unknown() }).safeParse(target)
      return new TabHandle(
        call,
        controlInput(
          PageTargetSchema.safeParse(receipt.success ? receipt.data.target : target),
          "page target",
          "Use control.tab(target) with the complete target returned by openTab/claimTab, or the receipt printed by mako-control open/claim; do not guess the generation or lease."
        )
      )
    },
    openTab: async (options: OpenTabOptions) => {
      const result = await call("page", { name: "open", args: { ...options } })
      const handle = bindPage(result)
      const { navigation } = z
        .object({ navigation: z.json().optional() })
        .parse(result)
      const failure = z
        .object({ fault: z.object({ message: z.string() }) })
        .safeParse(navigation)
      if (failure.success)
        throw new TabNavigationError(
          PageTargetSchema.parse(handle.target),
          navigation!,
          failure.data.fault.message
        )
      return handle
    },
    claimTab: async (options: {
      browser: string
      tab: string
      takeover?: boolean
    }) => {
      const args: JsonObject = { browser: options.browser, tab: options.tab }
      if (options.takeover !== undefined) args.takeover = options.takeover
      return bindPage(await call("page", { name: "select", args }))
    },
    apps: async (options: { all?: boolean } = {}) => appsValue(await call("targets", { kind: "apps", ...options })),
    windows: async (pid: number) => windowsValue(await call("targets", { kind: "windows", pid })),
    browsers: async () => browsersValue(await call("targets", { kind: "browsers" })),
    connectBrowser: async (browser: string) =>
      z
        .object({
          status: z.literal("connected"),
          generation: z.string().min(1),
        })
        .parse(await call("connect", { browser })),
    tabs: async (browser: string, options: { all?: boolean } = {}) =>
      tabsValue(await call("targets", { kind: "pages", browser, ...options })),
    native: (name: string, args: JsonObject = {}) =>
      call("native", { name, args }),
    command: async (options: {
      language: "shell" | "applescript" | "jxa"
      source: string
      cwd?: string
    }) =>
      ExecutionReceiptSchema.parse(
        await call("dispatch", { operation: { kind: "command", ...options } })
      ),
  })
}
