import { ControlReadScopeSchema } from "./scope.js"
import { z } from "zod"
import {
  ControlCapabilitiesSchema,
  ControlRouteSchema,
  VerificationKindSchema,
  WindowTargetSchema,
  type ControlCapabilities,
  type ControlRoute,
  type VerificationKind,
} from "../computer/control-contract.js"

export const PageTargetSchema = z
  .object({
    kind: z.literal("page"),
    browser: z.string().min(1),
    tab: z.string().min(1),
    generation: z.string().min(1),
    lease: z.string().min(1),
  })
  .strict()
export type PageTarget = z.infer<typeof PageTargetSchema>

export const WindowControlTargetSchema = WindowTargetSchema.extend({
  kind: z.literal("window"),
}).strict()
export type WindowControlTarget = z.infer<typeof WindowControlTargetSchema>

export const ControlTargetSchema = z.discriminatedUnion("kind", [
  PageTargetSchema,
  WindowControlTargetSchema,
])
export type ControlTarget = z.infer<typeof ControlTargetSchema>

export const NativeScreenshotOptionsSchema = z
  .object({
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    maxSide: z.number().int().min(256).max(4096).optional(),
    screenshot_out_file: z.string().min(1).optional(),
  })
  .strict()
export type NativeScreenshotOptions = z.infer<
  typeof NativeScreenshotOptionsSchema
>

const setTextOperationSchema = z
  .object({
    kind: z.literal("set-text"),
    ref: z.string().min(1),
    text: z.string().max(100_000),
  })
  .strict()
const activateOperationSchema = z
  .object({
    kind: z.literal("activate"),
    ref: z.string().min(1),
    action: z.enum(["press", "confirm", "pick", "open"]).default("press"),
  })
  .strict()
const pressKeyOperationSchema = z
  .object({
    kind: z.literal("press-key"),
    key: z.string().min(1).max(32),
    modifiers: z.array(z.string().min(1).max(32)).max(4).default([]),
    ref: z.string().min(1).optional(),
  })
  .strict()
const pointSchema = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      view: z.string().min(1).optional(),
    })
    .strict(),
])
export const pointerOperationSchema = z
  .object({
    kind: z.literal("pointer"),
    at: pointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    count: z.number().int().min(1).max(3).default(1),
  })
  .strict()
const scrollOperationSchema = z
  .object({
    kind: z.literal("scroll"),
    at: pointSchema.optional(),
    deltaX: z.number().finite().default(0),
    deltaY: z.number().finite().default(0),
  })
  .strict()
const selectOptionOperationSchema = z
  .object({
    kind: z.literal("select-option"),
    ref: z.string().min(1),
    value: z.string().max(4096).optional(),
    label: z.string().max(4096).optional(),
  })
  .refine(
    (operation) =>
      (operation.value === undefined) !== (operation.label === undefined),
    { message: "Pass exactly one of value or label" }
  )
const commandOperationSchema = z
  .object({
    kind: z.literal("command"),
    language: z.enum(["shell", "applescript", "jxa"]),
    source: z.string().min(1).max(200_000),
    cwd: z.string().min(1).optional(),
  })
  .strict()

export const ControlOperationSchema = z.discriminatedUnion("kind", [
  setTextOperationSchema,
  activateOperationSchema,
  pressKeyOperationSchema,
  pointerOperationSchema,
  scrollOperationSchema,
  selectOptionOperationSchema,
  commandOperationSchema,
])
export type ControlOperation = z.infer<typeof ControlOperationSchema>

export const ControlTargetsRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("apps") }).strict(),
  z
    .object({ kind: z.literal("windows"), pid: z.number().int().positive() })
    .strict(),
  z.object({ kind: z.literal("browsers") }).strict(),
  z.object({ kind: z.literal("pages"), browser: z.string().min(1) }).strict(),
])
export type ControlTargetsRequest = z.infer<typeof ControlTargetsRequestSchema>

export const ControlObserveRequestSchema = z
  .object({
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Zod schema composition API.
    ...ControlReadScopeSchema.shape,
    target: ControlTargetSchema,
    query: z.string().max(200).optional(),
    interactive: z.boolean().default(false),
    max: z.number().int().min(1).max(1000).default(250),
  })
  .strict()
export type ControlObserveRequest = z.infer<typeof ControlObserveRequestSchema>

export const ControlDispatchRequestSchema = z
  .object({
    target: ControlTargetSchema.optional(),
    operation: ControlOperationSchema,
  })
  .strict()
export type ControlDispatchRequest = z.infer<
  typeof ControlDispatchRequestSchema
>

export const ControlEventsRequestSchema = z
  .object({
    target: ControlTargetSchema,
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(128).default(32),
  })
  .strict()
export type ControlEventsRequest = z.infer<typeof ControlEventsRequestSchema>

export const ControlRawRequestSchema = z
  .object({
    backend: z.enum(["native", "page"]),
    name: z.string().min(1),
    args: z.record(z.string(), z.json()),
  })
  .strict()
export type ControlRawRequest = z.infer<typeof ControlRawRequestSchema>

export const TopologyRiskSchema = z.enum(["none", "bounded", "surface"])
export type TopologyRisk = z.infer<typeof TopologyRiskSchema>

export const ControlPlanSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("selected"),
      route: ControlRouteSchema,
      topology: TopologyRiskSchema,
      verification: VerificationKindSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("foreground-required"),
      route: z.literal("foreground"),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unsupported"),
      reasons: z.array(z.string()),
    })
    .strict(),
])
export type ControlPlan = z.infer<typeof ControlPlanSchema>

const operationPolicy = {
  "set-text": {
    routes: ["page", "accessibility"],
    topology: "none",
    verification: "read-back",
  },
  activate: {
    routes: ["page", "accessibility", "window-pointer"],
    topology: "surface",
    verification: "observation",
  },
  "press-key": {
    routes: ["page", "pid-keyboard", "foreground"],
    topology: "surface",
    verification: "observation",
  },
  pointer: {
    routes: ["page", "window-pointer", "foreground"],
    topology: "surface",
    verification: "observation",
  },
  scroll: {
    routes: ["page", "window-pointer", "foreground"],
    topology: "bounded",
    verification: "observation",
  },
  "select-option": {
    routes: ["page", "accessibility"],
    topology: "bounded",
    verification: "read-back",
  },
  command: {
    routes: ["command"],
    topology: "surface",
    verification: "direct",
  },
} satisfies Readonly<
  Record<
    ControlOperation["kind"],
    {
      routes: readonly ControlRoute[]
      topology: TopologyRisk
      verification: VerificationKind
    }
  >
>

function routeFromCapabilities(
  routes: readonly ControlRoute[],
  capabilities: ControlCapabilities
): ControlPlan {
  const byRoute = new Map(
    ControlCapabilitiesSchema.parse(capabilities).routes.map((route) => [
      route.route,
      route,
    ])
  )
  const reasons: string[] = []
  for (const route of routes) {
    const capability = byRoute.get(route)
    if (!capability) continue
    if (capability.status === "available") {
      return ControlPlanSchema.parse({
        status: "selected",
        route,
        topology: "surface",
        verification: capability.verification,
      })
    }
    if (capability.status === "foreground-required")
      return {
        status: "foreground-required",
        route: "foreground",
        reason: capability.reason,
      }
    reasons.push(`${route}: ${capability.reason}`)
  }
  return { status: "unsupported", reasons }
}

/** Selects a backend from the exact target and operation, never from model preference. */
export function planControlOperation(
  target: ControlTarget | undefined,
  operation: ControlOperation,
  capabilities?: ControlCapabilities
): ControlPlan {
  const parsedOperation = ControlOperationSchema.parse(operation)
  const policy = operationPolicy[parsedOperation.kind]
  if (parsedOperation.kind === "command")
    return {
      status: "selected",
      route: "command",
      topology: policy.topology,
      verification: policy.verification,
    }
  if (!target)
    return {
      status: "unsupported",
      reasons: ["This operation requires an exact page or window target."],
    }
  const parsedTarget = ControlTargetSchema.parse(target)
  if (parsedTarget.kind === "page")
    return {
      status: "selected",
      route: "page",
      topology: policy.topology,
      verification: policy.verification,
    }
  if (
    parsedOperation.kind === "press-key" &&
    parsedOperation.modifiers.some((modifier) =>
      ["cmd", "command", "meta"].includes(modifier.toLowerCase())
    )
  )
    return {
      status: "foreground-required",
      route: "foreground",
      reason:
        "The native driver has not passed background Command delivery acceptance. Use an exact page route, semantic control, command adapter, or an explicitly foreground workflow.",
    }
  if (!capabilities)
    return {
      status: "unsupported",
      reasons: ["Window capabilities have not been observed."],
    }
  // A native snapshot ref has no proven identity in a page, even when this
  // process also owns a registered browser endpoint.
  const selected = routeFromCapabilities(
    policy.routes.filter((route) => route !== "page"),
    capabilities
  )
  if (selected.status !== "selected") return selected
  return {
    ...selected,
    topology: policy.topology,
    verification: policy.verification,
  }
}
