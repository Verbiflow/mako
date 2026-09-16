import { z } from "zod"
import {
  PageTargetSchema,
  type PageTarget,
} from "../control/contract.js"
import type { JsonValue } from "../json.js"
import {
  PageNodeSelectorSchema,
  PageObservationSchema,
  pageNodeLines,
  selectPageNodes,
  type PageNodeSelection,
  type PageNodeSelector,
  type PageObservation,
} from "./observation.js"
import type {
  CdpCommand,
  CdpCommandArguments,
  CdpCommandResult,
} from "./protocol.js"

const pageArgumentsSchema = z.record(z.string(), z.json())
const pageObserveOptionsSchema = z
  .object({
    maxNodes: z.number().int().min(1).max(1000).default(250),
    offset: z.number().int().nonnegative().default(0),
    query: z.string().max(200).optional(),
    interactiveOnly: z.boolean().default(false),
    since: z.string().optional(),
    frameId: z.string().optional(),
  })
  .strict()
export type PageObserveOptions = z.input<typeof pageObserveOptionsSchema>

export type PageActionCall = (
  action: string,
  args: Readonly<Record<string, JsonValue>>
) => Promise<JsonValue>

export interface PageHelpers {
  open(options: {
    browser: string
    url?: string
    background?: boolean
    disposition?: "tab" | "window"
    lifetime?: "task" | "persistent"
    context?: "profile" | "isolated"
  }): Promise<PageTarget>
  claim(options: {
    browser: string
    tab: string
    takeover?: boolean
  }): Promise<PageTarget>
  release(target: PageTarget): Promise<JsonValue>
  close(target: PageTarget): Promise<JsonValue>
  observe(
    target: PageTarget,
    options?: PageObserveOptions
  ): Promise<PageObservation>
  select(
    observation: PageObservation,
    selector: PageNodeSelector
  ): PageNodeSelection
  lines(selection: PageNodeSelection): string[]
  cdp<Method extends CdpCommand>(
    target: PageTarget,
    method: Method,
    ...args: CdpCommandArguments<Method>
  ): Promise<CdpCommandResult<Method>>
}

function browserTarget(target: PageTarget) {
  const parsed = PageTargetSchema.parse(target)
  return {
    browser: parsed.browser,
    tab: parsed.tab,
    generation: parsed.generation,
    lease: parsed.lease,
  }
}

function pageTarget(value: JsonValue): PageTarget {
  const target = z
    .object({
      browser: z.string(),
      tab: z.string(),
      generation: z.string(),
      lease: z.string(),
    })
    .parse(value)
  return PageTargetSchema.parse({ kind: "page", ...target })
}

/**
 * Page-only code helpers over a host-owned action dispatcher. They add no
 * authority: ownership, schema validation and uncertainty remain in the host.
 */
export function pageHelpers(call: PageActionCall): PageHelpers {
  return {
    async open(options) {
      const args = { browser: options.browser }
      if (options.url !== undefined) Object.assign(args, { url: options.url })
      if (options.background !== undefined)
        Object.assign(args, { background: options.background })
      if (options.disposition !== undefined)
        Object.assign(args, { disposition: options.disposition })
      if (options.lifetime !== undefined)
        Object.assign(args, { lifetime: options.lifetime })
      if (options.context !== undefined)
        Object.assign(args, { context: options.context })
      return pageTarget(await call("open", args))
    },
    async claim(options) {
      const args = {
        browser: options.browser,
        tab: options.tab,
      }
      if (options.takeover !== undefined)
        Object.assign(args, { takeover: options.takeover })
      return pageTarget(await call("select", args))
    },
    release(target) {
      return call("release", { target: browserTarget(target) })
    },
    close(target) {
      return call("close", { target: browserTarget(target) })
    },
    async observe(target, options = {}) {
      const parsed = pageObserveOptionsSchema.parse(options)
      return PageObservationSchema.parse(
        await call("observe", {
          target: browserTarget(target),
          ...parsed,
        })
      )
    },
    select(observation, selector) {
      return selectPageNodes(
        PageObservationSchema.parse(observation),
        PageNodeSelectorSchema.parse(selector)
      )
    },
    lines(selection) {
      return pageNodeLines(selection.nodes)
    },
    async cdp<Method extends CdpCommand>(
      target: PageTarget,
      method: Method,
      ...args: CdpCommandArguments<Method>
    ): Promise<CdpCommandResult<Method>> {
      const params = pageArgumentsSchema.parse(args[0] ?? {})
      const value = await call("cdp", {
        target: browserTarget(target),
        method,
        params,
      })
      // SAFETY: The host dispatches this exact pinned protocol method and
      // validates the returned frame as JSON before it reaches this seam.
      return value as CdpCommandResult<Method>
    },
  }
}
