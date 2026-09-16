import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"

/**
 * The product-owned control contract. Native drivers, page transports and
 * command adapters may all implement a route, but callers reason about these
 * guarantees instead of a vendor's tool names or result fields.
 */

export const WindowTargetSchema = z.object({
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
})
export type WindowTarget = z.infer<typeof WindowTargetSchema>

export const ControlRouteSchema = z.enum([
  "command",
  "page",
  "accessibility",
  "window-pointer",
  "pid-keyboard",
  "menu",
  "foreground",
  "native",
])
export type ControlRoute = z.infer<typeof ControlRouteSchema>

export const VerificationKindSchema = z.enum([
  "direct",
  "read-back",
  "event",
  "observation",
  "unverifiable",
])
export type VerificationKind = z.infer<typeof VerificationKindSchema>

const availableRouteSchema = z.object({
  route: ControlRouteSchema,
  status: z.literal("available"),
  background: z.boolean(),
  verification: VerificationKindSchema,
  detail: z.string(),
  browser: z.string().optional(),
})
const unavailableRouteSchema = z.object({
  route: ControlRouteSchema,
  status: z.literal("unavailable"),
  reason: z.string(),
})
const foregroundRouteSchema = z.object({
  route: ControlRouteSchema,
  status: z.literal("foreground-required"),
  reason: z.string(),
})
export const RouteCapabilitySchema = z.discriminatedUnion("status", [
  availableRouteSchema,
  unavailableRouteSchema,
  foregroundRouteSchema,
])
export type RouteCapability = z.infer<typeof RouteCapabilitySchema>

export const ControlCapabilitiesSchema = z.object({
  target: WindowTargetSchema,
  routes: z.array(RouteCapabilitySchema),
})
export type ControlCapabilities = z.infer<typeof ControlCapabilitiesSchema>

export const ControlIntentSchema = z.enum([
  "exact",
  "text",
  "control",
  "page",
  "pointer",
  "keyboard",
  "menu",
  "visual",
])
export type ControlIntent = z.infer<typeof ControlIntentSchema>

const ROUTES_BY_INTENT = {
    exact: ["command", "page", "accessibility", "foreground"],
    text: ["accessibility", "page", "command", "pid-keyboard", "foreground"],
    control: [
      "accessibility",
      "page",
      "command",
      "window-pointer",
      "foreground",
    ],
    page: ["page", "accessibility", "window-pointer", "foreground"],
    pointer: ["page", "accessibility", "window-pointer", "foreground"],
    keyboard: [
      "page",
      "accessibility",
      "pid-keyboard",
      "menu",
      "foreground",
    ],
    menu: ["command", "page", "accessibility", "menu", "foreground"],
  visual: ["page", "window-pointer", "foreground"],
} satisfies Readonly<Record<ControlIntent, readonly ControlRoute[]>>

export interface WindowCapabilityFacts {
  target: WindowTarget
  documentWindows: number
  onScreen: boolean | null
  pageBrowser?: string
}

/** Capabilities proven for one exact window generation, before dispatch. */
export function windowCapabilities(
  facts: WindowCapabilityFacts
): ControlCapabilities {
  const hidden = facts.onScreen === false
  const ambiguousKeyboard = facts.documentWindows > 1
  const routes: RouteCapability[] = [
    {
      route: "command",
      status: "available",
      background: true,
      verification: "direct",
      detail:
        "Application scripts and shell commands run without targeting the user's keyboard or pointer.",
    },
    facts.pageBrowser
      ? {
          route: "page",
          status: "available",
          background: true,
          verification: "event",
          detail:
            "The exact Chromium page is bound through browser control; DOM, lifecycle and screenshot evidence are available.",
          browser: facts.pageBrowser,
        }
      : {
          route: "page",
          status: "unavailable",
          reason:
            "No exact page binding exists for this process. A supported application must be launched or explicitly attached with a page route.",
        },
    {
      route: "accessibility",
      status: "available",
      background: true,
      verification: "read-back",
      detail:
        "Element actions and value writes are addressed semantically and can be checked against a fresh accessibility observation.",
    },
    hidden
      ? {
          route: "window-pointer",
          status: "unavailable",
          reason:
            "Window-local pixels are unavailable while this window is hidden, minimized or off screen.",
        }
      : {
          route: "window-pointer",
          status: "available",
          background: true,
          verification: "observation",
          detail:
            "Window-local pixel input is best effort and must be verified from a later observation.",
        },
    ambiguousKeyboard
      ? {
          route: "pid-keyboard",
          status: "unavailable",
          reason: `${String(facts.documentWindows)} document windows share this process, so a process-routed key is ambiguous.`,
        }
      : hidden
        ? {
            route: "pid-keyboard",
            status: "unavailable",
            reason:
              "Synthetic key commits are unavailable while this window is hidden, minimized or off screen.",
          }
        : {
            route: "pid-keyboard",
            status: "available",
            background: true,
            verification: "unverifiable",
            detail:
              "Process-routed keys may reach native controls; renderer-backed controls commonly drop them. Observe the postcondition before another mutation.",
          },
    {
      route: "menu",
      status: "foreground-required",
      reason:
        "Invoking an application menu fronts the application briefly and restores the previous one.",
    },
    {
      route: "foreground",
      status: "foreground-required",
      reason:
        "Raw input is global and requires the exact target to be frontmost plus an explicit foreground declaration.",
    },
  ]
  return ControlCapabilitiesSchema.parse({ target: facts.target, routes })
}

export type RouteDecision =
  | { status: "selected"; capability: RouteCapability }
  | {
      status: "foreground-required"
      capability: Extract<RouteCapability, { status: "foreground-required" }>
    }
  | { status: "unavailable"; reasons: string[] }

/**
 * Selects the strongest proven route for an intent. Foreground is never
 * selected: it is returned as a declaration the caller must explicitly make.
 */
export function selectRoute(
  intent: ControlIntent,
  capabilities: ControlCapabilities
): RouteDecision {
  const byRoute = new Map(
    capabilities.routes.map((capability) => [capability.route, capability])
  )
  const reasons: string[] = []
  for (const route of ROUTES_BY_INTENT[intent]) {
    const capability = byRoute.get(route)
    if (!capability) continue
    if (capability.status === "available")
      return { status: "selected", capability }
    if (capability.status === "foreground-required")
      return { status: "foreground-required", capability }
    reasons.push(`${route}: ${capability.reason}`)
  }
  return { status: "unavailable", reasons }
}

export const ActionOutcomeSchema = z.enum([
  "confirmed",
  "unverifiable",
  "suspected-noop",
  "refused",
  "unknown",
])
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>

export const ActionReceiptSchema = z.object({
  action: z.string().min(1),
  target: WindowTargetSchema.optional(),
  route: ControlRouteSchema,
  backend_route: z.string().optional(),
  delivery: z.enum(["background", "foreground", "none"]),
  outcome: ActionOutcomeSchema,
  verification: z
    .object({
      kind: VerificationKindSchema,
      status: z.enum(["confirmed", "changed", "unchanged"]),
    })
    .optional(),
  fronted: z
    .object({
      pid: z.number().int().positive().optional(),
      ms: z.number().nonnegative(),
    })
    .optional(),
})
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>

export function withReceiptVerification(
  receipt: ActionReceipt,
  verification: NonNullable<ActionReceipt["verification"]>
): ActionReceipt {
  return ActionReceiptSchema.parse({
    ...receipt,
    outcome:
      verification.status === "confirmed" ? "confirmed" : receipt.outcome,
    verification,
  })
}

const driverResultSchema = z.looseObject({
  route: z.string().optional(),
  effect: z.string().optional(),
  verified: z.boolean().optional(),
  delivery: z.looseObject({ mode: z.string().optional() }).optional(),
  actual_delivery: z.string().optional(),
  fronted: z
    .object({
      pid: z.number().int().positive().optional(),
      ms: z.number().nonnegative(),
    })
    .optional(),
})

function canonicalRoute(
  action: string,
  args: JsonObject,
  backendRoute: string | undefined
): ControlRoute {
  if (
    backendRoute === "accessibility" ||
    backendRoute === "window-pointer" ||
    backendRoute === "pid-keyboard" ||
    backendRoute === "menu" ||
    backendRoute === "foreground" ||
    backendRoute === "page" ||
    backendRoute === "command"
  )
    return backendRoute
  if (action === "script" || action === "shell") return "command"
  if (action === "invoke_menu") return "menu"
  if (args.delivery_mode === "foreground") return "foreground"
  if (z.string().safeParse(args.element_token).success) return "accessibility"
  if (action === "hotkey" || action === "press_key" || action === "type_text")
    return "pid-keyboard"
  if (
    action === "click" ||
    action === "double_click" ||
    action === "right_click" ||
    action === "drag" ||
    action === "scroll"
  )
    return "window-pointer"
  return "native"
}

function canonicalOutcome(
  parsed: z.infer<typeof driverResultSchema>
): ActionOutcome {
  if (parsed.verified === true || parsed.effect === "confirmed")
    return "confirmed"
  if (parsed.effect === "suspected_noop") return "suspected-noop"
  if (parsed.effect === "unverifiable") return "unverifiable"
  return "unverifiable"
}

/** Converts an adapter result into the stable receipt programs keep. */
export function actionReceipt(
  action: string,
  args: JsonObject,
  target: WindowTarget | undefined,
  result: JsonValue
): ActionReceipt {
  const parsed = driverResultSchema.safeParse(result)
  const value = parsed.success ? parsed.data : {}
  const route = canonicalRoute(action, args, value.route)
  const mode = value.delivery?.mode ?? value.actual_delivery
  const delivery =
    value.fronted || mode === "foreground"
      ? "foreground"
      : route === "command"
        ? "none"
        : "background"
  const receipt: ActionReceipt = {
    action,
    route,
    delivery,
    outcome: canonicalOutcome(value),
  }
  if (target) receipt.target = WindowTargetSchema.parse(target)
  if (value.route && value.route !== route) receipt.backend_route = value.route
  if (value.fronted) receipt.fronted = value.fronted
  return ActionReceiptSchema.parse(receipt)
}
