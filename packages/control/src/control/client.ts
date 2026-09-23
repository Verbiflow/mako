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
  scopeControlNodes,
  type ControlReadScope,
} from "./scope.js"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import {
  ControlOperationSchema,
  ControlTargetSchema,
  PageTargetSchema,
  WindowControlTargetSchema,
  type ControlTarget,
  type PageTarget,
} from "./contract.js"
import {
  PageObservationNodeSchema,
  pageNodeLines,
  selectPageNodes,
  type PageNodeSelector,
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
  scope: ControlReadScopeSchema.optional(),
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
export type ElementSelector = z.infer<typeof selectorSchema>
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
  get nodes() {
    return this.data.nodes
  }
  get lines() {
    return this.data.lines
  }
  get coverage() {
    return this.data.coverage
  }
  get(selector: ElementSelector) {
    const { role, name, within } = selectorSchema.parse(selector)
    const matches = scopeControlNodes(this.nodes, {
      within,
      match: { role, name },
    })
    if (matches.length !== 1)
      throw new Error(
        `Expected one observed ${role} ${JSON.stringify(name)}, found ${matches.length}. Candidates: ${JSON.stringify(matches.slice(0, 5).map((node) => ({ ref: node.ref, role: node.role, name: node.name?.slice(0, 120), depth: node.depth })))}. Observe a narrower scope or disambiguate; nothing was dispatched.`
      )
    return matches[0]!
  }
  select(selector: PageNodeSelector) {
    const selection = selectPageNodes({ nodes: this.nodes }, selector)
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
export const NativeSettlingSchema = z.object({
  status: z.enum(["events_quiet", "deadline", "unavailable"]),
  scope: z.literal("process_notifications"),
  elapsed_ms: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  subscriptions: z.number().int().nonnegative(),
}).strict()
export type NativeSettling = z.infer<typeof NativeSettlingSchema>

export const ExecutionReceiptSchema = z.object({
  status: z.literal("dispatched"),
  actionId: z.string(),
  route: z.string(),
  delivery: z.enum(["background", "foreground", "none"]),
  verification: z.literal("not-requested"),
  settling: NativeSettlingSchema.optional(),
  guard: z.record(z.string(), z.json()),
  result: z.json().optional(),
})
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>
export type ObserveOptions = ControlReadScope & {
  query?: string
  interactive?: boolean
  max?: number
}
const pointSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    view: z.string().min(1),
  })
  .strict()
export type Point = z.infer<typeof pointSchema>

export class ControlHandle {
  readonly target: ControlTarget
  constructor(
    protected readonly call: ControlCall,
    target: ControlTarget
  ) {
    this.target = Object.freeze(ControlTargetSchema.parse(target))
  }
  locator(selector: ElementSelector) {
    return new ControlLocator(this, selectorSchema.parse(selector))
  }
  async observe(options: ObserveOptions = {}) {
    return new ControlObservation(
      await this.call("observe", { ...options, target: this.target })
    )
  }
  async record(options: RecordingOptions = {}) {
    const receipt = recordingReceipt(
      RecordingReceiptSchema.parse(
        await this.call("recording", {
          operation: "start",
          target: this.target,
          options: RecordingOptionsSchema.parse(options),
        })
      ),
      this.target
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
        operation: ControlOperationSchema.parse(operation),
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
    const reference = z.string().safeParse(at)
    if (
      reference.success &&
      (options.button ?? "left") === "left" &&
      (options.count ?? 1) === 1
    )
      return this.activate(reference.data)
    return this.perform({
      kind: "pointer",
      at: reference.success ? { ref: reference.data } : pointSchema.parse(at),
      ...options,
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
  ) {
    const wanted = expectationSchema.parse(expectation)
    const timing = z
      .object({
        timeoutMs: z.number().int().min(0).max(55_000).default(5000),
        everyMs: z.number().int().min(20).max(2000).default(100),
      })
      .strict()
      .parse(options)
    const deadline = Date.now() + timing.timeoutMs
    for (;;) {
      const view = await this.observe({
        max: 2,
        within: wanted.within,
        match: { role: wanted.role, name: wanted.name },
      })
      const matches = view.nodes.filter(
        (node) => node.role === wanted.role && (node.name ?? "") === wanted.name
      )
      if (matches.length > 1)
        throw new Error(
          `Assertion ambiguous: ${matches.length} observed ${wanted.role} ${JSON.stringify(wanted.name)}`
        )
      const node = matches[0]
      if (
        node?.valueExact === false &&
        (wanted.value !== undefined || wanted.states?.value !== undefined)
      )
        throw new Error(
          "Exact value unavailable: this native driver returned display-normalized text. An exact-value-capable driver is required; no input was replayed."
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
        throw new Error(
          `Assertion not established: ${JSON.stringify(wanted)}; ${JSON.stringify(view)}`
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
    private readonly selector: ElementSelector
  ) {}
  locator(selector: ElementSelector) {
    const next = selectorSchema.parse(selector)
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
      throw new Error(
        "Locator coverage is incomplete. Narrow its scope; nothing was dispatched."
      )
    const node = view.get({
      role: this.selector.role,
      name: this.selector.name,
    })
    if (!node.ref)
      throw new Error(
        "The matched element has no actionable reference; nothing was dispatched."
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
  expect(
    expectation: Omit<ElementExpectation, "role" | "name" | "within">,
    options: { timeoutMs?: number; everyMs?: number } = {}
  ) {
    return this.handle.expect({ ...expectation, ...this.selector }, options)
  }
  toJSON() {
    return { target: this.handle.target, selector: this.selector }
  }
}

export class WindowHandle extends ControlHandle {
  screenshot(options: JsonObject = {}) {
    return this.call("capture", { target: this.target, options })
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
      params: z.record(z.string(), z.json()).parse(args[0] ?? {}),
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
    this.pid = z.number().int().positive().parse(pid)
  }
  windows() {
    return this.call("targets", { kind: "windows", pid: this.pid })
  }
  window(windowId: number) {
    return new WindowHandle(
      this.call,
      WindowControlTargetSchema.parse({
        kind: "window",
        pid: this.pid,
        window_id: windowId,
      })
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
    app: (target: { pid: number }) => new AppHandle(call, target.pid),
    window: (target: { pid: number; window_id: number }) =>
      new WindowHandle(
        call,
        WindowControlTargetSchema.parse({ kind: "window", ...target })
      ),
    tab: (target: PageTarget) =>
      new TabHandle(call, PageTargetSchema.parse(target)),
    openTab: async (options: OpenTabOptions) =>
      bindPage(await call("page", { name: "open", args: { ...options } })),
    claimTab: async (options: {
      browser: string
      tab: string
      takeover?: boolean
    }) => {
      const args: JsonObject = { browser: options.browser, tab: options.tab }
      if (options.takeover !== undefined) args.takeover = options.takeover
      return bindPage(await call("page", { name: "select", args }))
    },
    apps: () => call("targets", { kind: "apps" }),
    windows: (pid: number) => call("targets", { kind: "windows", pid }),
    browsers: () => call("targets", { kind: "browsers" }),
    tabs: (browser: string) => call("targets", { kind: "pages", browser }),
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
