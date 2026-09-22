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
        `Expected one observed ${role} ${JSON.stringify(name)}, found ${matches.length}. Observe a narrower scope or disambiguate; nothing was dispatched.`
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
    // A multiset comparison ignores snapshot addresses, never carries them into a new view.
    const key = (line: string) => line.replace(/^[A-Za-z0-9_-]+:\d+ /, "")
    const subtract = (left: string[], right: string[]) => {
      const counts = new Map<string, number>()
      for (const line of right)
        counts.set(key(line), (counts.get(key(line)) ?? 0) + 1)
      return left.filter((line) => {
        const n = counts.get(key(line)) ?? 0
        if (!n) return true
        counts.set(key(line), n - 1)
        return false
      })
    }
    return {
      target: this.target,
      observation: this.observation,
      coverage: this.coverage,
      added: subtract(this.lines, previous.lines),
      removed: subtract(previous.lines, this.lines).map(key),
    }
  }
  toJSON() {
    return {
      target: this.target,
      observation: this.observation,
      lines: this.lines,
      coverage: this.coverage,
      scope: this.data.scope,
    }
  }
}

export const ExecutionReceiptSchema = z.object({
  status: z.literal("dispatched"),
  actionId: z.string(),
  route: z.string(),
  delivery: z.enum(["background", "foreground", "none"]),
  verification: z.literal("not-requested"),
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
  async observe(options: ObserveOptions = {}) {
    return new ControlObservation(
      await this.call("observe", { ...options, target: this.target })
    )
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
      const matched = wanted.absent
        ? !node && view.coverage.complete && view.coverage.textComplete
        : node !== undefined &&
          view.coverage.textComplete &&
          (wanted.value === undefined || node.value === wanted.value) &&
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
  browser: string
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
    }) =>
      bindPage(await call("page", { name: "select", args: { ...options } })),
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
