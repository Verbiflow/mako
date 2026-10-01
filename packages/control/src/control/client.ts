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
  type ControlReadScope,
  type NameMatch,
} from "./scope.js"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import {
  ControlOperationSchema,
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

/** Explains a miss where the requested name is only what the control shows;
 * string names stay exact, so the fix is to use the listed accessible name. */
function visibleTextHint(nodes: readonly PageObservationNode[], role: string, name: NameMatch) {
  if (typeof name !== "string") return ""
  const shown = nodes
    .filter((node) => node.role === role && node.visibleText !== undefined && spaced(node.visibleText) === spaced(name))
    .slice(0, 3)
  if (!shown.length) return ""
  const named = shown.map((node) => `${role} ${JSON.stringify(node.name ?? "")}${node.ref ? ` (${node.ref})` : ""}`).join(", ")
  return `${JSON.stringify(name)} is the visible text of ${named}. A string name matches the accessible name exactly, so use locator({role:${JSON.stringify(role)},name:${JSON.stringify(shown[0]!.name ?? "")}}) or name:{contains:${JSON.stringify(name)}}; nothing was dispatched.`
}

/** Structured evidence stays local; returning an observation emits its compact view once. */
export class ControlObservation {
  readonly data: ControlObservationData
  constructor(value: JsonValue | ControlObservationData) {
    this.data = ControlObservationSchema.parse(value)
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
    return { ...compact, nodes, toJSON: () => compact }
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
      target: this.target,
      observation: this.observation,
      lineage: this.data.lineage,
      lines: this.lines,
      coverage: this.coverage,
      scope: this.data.scope,
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
    return ExecutionReceiptSchema.parse(
      await this.call("dispatch", {
        target: this.target,
        operation: controlInput(
          ControlOperationSchema.safeParse(operation),
          "operation",
          "Use setValue(ref,text), click(ref), pressKey(key,{modifiers?}) or scroll({deltaX?,deltaY?,at?}); copy refs from this target’s latest observation."
        ),
      })
    )
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
  async expect(
    expectation: ElementExpectation,
    options: { timeoutMs?: number; everyMs?: number } = {}
  ): Promise<ControlExpectationResult> {
    const wanted = controlInput(
      expectationSchema.safeParse(regexNames(expectation)),
      "expectation",
      'Use {role:"textbox",name:"Name",value:"Ada"}; optional within, states, absent.'
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
        return {
          status: "matched" as const,
          target: this.target,
          observation: view.observation,
          expectation: wanted,
          evidence: node ?? null,
          coverage: view.coverage,
        }
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
  screenshot(options: NativeScreenshotOptions = {}) {
    return this.call("capture", {
      target: this.target,
      options: { ...options },
    })
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
  screenshot(options: JsonObject = {}) {
    return this.call("capture", { target: this.target, options })
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
  inspect(ref: string, options: { attributes?: string[]; styles?: string[] } = {}) {
    return this.raw("inspect", { ref, ...options })
  }
  private async dispatched(action: string, args: JsonObject) {
    const result = await this.raw(action, args)
    return { status: "dispatched" as const, action, verification: "not-requested" as const, result }
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
    condition: { text?: string; selector?: string; url?: string; hidden?: boolean; networkIdle?: boolean },
    options: { timeoutMs?: number } = {}
  ) {
    const timeoutMs = controlInput(
      z.number().int().min(100).max(55_000).default(10_000).safeParse(options.timeoutMs),
      "wait timeout",
      "Use {timeoutMs:10000}; 100–55000."
    )
    const result = z
      .object({ satisfied: z.boolean(), elapsedMs: z.number() })
      .parse(await this.raw("wait", { for: { ...condition }, timeoutMs }))
    if (!result.satisfied)
      throw new ControlFault(
        "assertion-failed",
        `Not established within ${timeoutMs} ms: ${JSON.stringify(condition)}. Observe or screenshot to see the page's state; nothing was dispatched.`,
        "not-dispatched"
      )
    return result
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
  windows() {
    return this.call("targets", { kind: "windows", pid: this.pid })
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
    apps: (options: { all?: boolean } = {}) => call("targets", { kind: "apps", ...options }),
    windows: (pid: number) => call("targets", { kind: "windows", pid }),
    browsers: () => call("targets", { kind: "browsers" }),
    connectBrowser: async (browser: string) =>
      z
        .object({
          status: z.literal("connected"),
          generation: z.string().min(1),
        })
        .parse(await call("connect", { browser })),
    tabs: (browser: string, options: { all?: boolean } = {}) => call("targets", { kind: "pages", browser, ...options }),
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
