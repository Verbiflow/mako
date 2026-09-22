import { z } from "zod"
import type { JsonObject } from "../json.js"

/**
 * The order of routes for reaching a native window without taking the
 * user's screen. Measured on 2026-09-14 against cua-driver 0.28.0 and a
 * backgrounded Electron window (`scripts/test-local-control-e2e.mjs`):
 * accessibility writes and presses land and read back; a pixel click posted
 * to the pid resolves through accessibility; `invoke_menu` performs the
 * item (Select All selected the field's 36 characters) but the driver
 * fronts the application for the invocation and restores the prior
 * frontmost app, about four seconds for a fresh menu; and every synthetic
 * key — `type_text`'s fallback, `press_key`, `hotkey`, with or without
 * modifiers — reports `escalation.reason: delivery_failed` and changes
 * nothing in the renderer, whatever the driver's own description promises
 * about the auth-message envelope. On a Cocoa field (F3 of the audit)
 * `type_text` lands, a Cmd chord did not with that driver, and a Shift+arrow chord lands while
 * the driver still reports it `delivery_failed`. So the driver's own
 * delivery verdict on keys is a hint, the read-back is the truth, and the
 * wrapper says both (`keyRouteAdvice`).
 */
export const BACKGROUND_INPUT_LADDER = [
  {
    route: "accessibility",
    action:
      "set_value, fill, click(element_token) with action press/pick/confirm/open, submit",
    when: "An observed element exposes the value or action you need. Background, no focus change, verifiable by read-back on the same control. This is how to write into a backgrounded Electron or Chromium field: fill (set_value plus read-back) replaces its text where a keyboard would select-all and retype.",
  },
  {
    route: "page",
    action:
      "browser.<action>({browser: 'app:<bundle>', ...}) after launch_app({..., page_route: true})",
    when: "The application is Electron or Chromium and Mako launched it with a debugging port: the page route gives keyboard, pointer, DOM reads and screenshots in the background with no focus change. computer programs have the browser object too.",
  },
  {
    route: "command",
    action:
      "script({language: 'applescript' | 'jxa', source}), shell({command})",
    when: "The intent has a command: a Finder or System Events operation, an application with a scripting dictionary, a file or process fact. Runs detached from the desk's focus; the result is the command's output with the same spill as everything else.",
  },
  {
    route: "window-pointer",
    action:
      "click, double_click, right_click, drag, scroll with x,y (or from_zoom)",
    when: "Window-local screenshot pixels from this window's latest capture (element frames are screen points: subtract window_bounds and multiply by screenshot_scale). Posted to the window's pid without fronting it. Electron and Chromium windows ignore background scrolling on macOS.",
  },
  {
    route: "pid-keyboard",
    action:
      "type_text, press_key, hotkey (delivery_mode background, the default)",
    when: "Native Cocoa fields only. Background Cmd chords remain refused pending exact-window keyboard acceptance; candidate driver success on a fixture does not establish support across applications. A Chromium or Electron renderer that is not frontmost drops every posted key. The driver cannot read a key back; use act('press_key', …) so the window delta says whether it landed, and switch route when it did not.",
  },
  {
    route: "menu",
    action: "invoke_menu({pid, window_id, path, foreground: true})",
    when: "The intent is a menu item or its shortcut (Undo, Save, Close Window, Select All) and no element action or command does it. Resolves the exact path through accessibility and fails closed. The driver fronts the application to invoke the item and restores the previous frontmost app itself; the call takes the screen for about a second, so it requires foreground: true and the result reports fronted.ms.",
  },
  {
    route: "foreground",
    action:
      "any input action with delivery_mode: 'foreground', window_id and foreground: true",
    when: "The only keyboard route into a renderer without a page route, and the route for a native app that ignores a background combo when no menu path exists. Foreground input is global input: Mako first checks that this exact application and window are already frontmost and refuses otherwise. It never escalates on its own; the user or the program brings the window forward deliberately, and bring_to_front requires foreground: true.",
  },
] as const

/** Keyboard tools: the driver cannot read a combo back and drops keys on backgrounded renderers. */
export const KEYBOARD_TOOLS: ReadonlySet<string> = new Set([
  "hotkey",
  "press_key",
  "type_text",
])

/**
 * Actions that take the user's screen for a moment even when they restore
 * it: they require `foreground: true` on the call.
 */
export const FRONTING_ACTIONS: ReadonlySet<string> = new Set([
  "invoke_menu",
  "bring_to_front",
])

/** The flag that declares a fronting call; stripped before the driver sees it. */
export const FOREGROUND_FLAG = "foreground"
/** The flag that posts a background Cmd chord anyway; stripped before the driver sees it. */
export const FORCE_FLAG = "force"

export const KEY_ROUTE_ADVICE = {
  unconfirmed: {
    status: "unconfirmed",
    reason:
      "The driver could not confirm these key events were delivered (it reports delivery_failed). A Chromium or Electron renderer that is not frontmost drops every posted key; a Cocoa field may have taken them. Read the field back (act, view) before deciding; do not retry the same call blindly.",
    routes:
      "Write the field with fill or set_value (background, verifiable). Perform a menu item with invoke_menu({pid, window_id, path, foreground: true}); the driver fronts the app briefly and restores the previous frontmost app. Drive an Electron or Chromium app through its page route. Keyboard reaches a renderer only with delivery_mode:'foreground' and foreground: true once its window is already frontmost; Mako never escalates on its own.",
  },
  unverifiable: {
    status: "unverifiable",
    reason:
      "The driver cannot read a key combo back. Read the field or window state (act, view, verify_state) before deciding it landed.",
    routes:
      "If the combo stands for a menu item, invoke_menu({pid, window_id, path, foreground: true}) performs and verifies it. A combo never focuses a field: establish focus first.",
  },
} as const

const keyOutcomeSchema = z.object({
  effect: z.string().optional(),
  escalation: z.looseObject({ reason: z.string().optional() }).optional(),
})

/**
 * Mako's reading of a keyboard result the driver could not confirm: not
 * confirmed delivered (`delivery_failed`, which the driver also reports
 * for chords that landed) or merely unverified, and in both cases the
 * routes that can do the job. Undefined when the driver confirmed it.
 */
export function keyRouteAdvice(
  structuredContent: JsonObject | undefined
): (typeof KEY_ROUTE_ADVICE)[keyof typeof KEY_ROUTE_ADVICE] | undefined {
  const outcome = keyOutcomeSchema.safeParse(structuredContent)
  if (!outcome.success) return undefined
  if (outcome.data.escalation?.reason === "delivery_failed")
    return KEY_ROUTE_ADVICE.unconfirmed
  if (outcome.data.effect === "unverifiable")
    return KEY_ROUTE_ADVICE.unverifiable
  return undefined
}

const escalationSchema = z.looseObject({ reason: z.string().optional() })

/**
 * The driver's `escalation` names a target ("foreground") and, in prose,
 * asks for `delivery_mode: "foreground"`. A model that reads the nudge takes
 * it; Mako's `mako_routes` already says what to do instead. Only the reason
 * survives, because `keyRouteAdvice` and a program's branch read it.
 */
export function withoutEscalationNudge(value: JsonObject): JsonObject {
  const escalation = escalationSchema.safeParse(value.escalation)
  if (!escalation.success) return value
  const next: JsonObject = { ...value }
  if (escalation.data.reason === undefined) delete next.escalation
  else next.escalation = { reason: escalation.data.reason }
  return next
}

export interface Refusal {
  code: "foreground-required" | "background-chord"
  message: string
}

const CMD_KEYS: ReadonlySet<string> = new Set(["cmd", "command", "meta"])

const keysSchema = z.array(z.string())
const chordArgsSchema = z.object({
  keys: keysSchema.optional(),
  modifiers: keysSchema.optional(),
  delivery_mode: z.string().optional(),
})

function isBackgroundCmdChord(action: string, args: JsonObject): boolean {
  if (action !== "hotkey" && action !== "press_key") return false
  const parsed = chordArgsSchema.safeParse(args)
  if (!parsed.success) return false
  if (parsed.data.delivery_mode === "foreground") return false
  const keys = [...(parsed.data.keys ?? []), ...(parsed.data.modifiers ?? [])]
  return keys.some((key) => CMD_KEYS.has(key.toLowerCase()))
}

/**
 * What Mako refuses before the driver is asked. Fronting is a declared
 * step: `invoke_menu`, `bring_to_front` and `delivery_mode: "foreground"`
 * need `foreground: true` on the call. A Cmd chord posted to a backgrounded
 * application failed with the installed driver in the original acceptance
 * tests, so it remains refused with
 * the routes that work rather than posted and waited on for a second;
 * `force: true` posts it anyway for an application whose own key handler
 * reads it.
 */
export function refusalFor(
  action: string,
  args: JsonObject
): Refusal | undefined {
  const declared = args[FOREGROUND_FLAG] === true
  if (FRONTING_ACTIONS.has(action) && !declared)
    return {
      code: "foreground-required",
      message: `${action} takes the user's screen: the driver fronts the application for the call${action === "invoke_menu" ? " and restores the previous frontmost app" : " and leaves it in front"}. Pass foreground: true to declare that, and only when the task calls for it. Background routes: fill or set_value for text, click(element_token) for a control, a page route for an Electron or Chromium app, script for an application with a scripting dictionary.`,
    }
  if (args.delivery_mode === "foreground" && !declared)
    return {
      code: "foreground-required",
      message:
        "delivery_mode: 'foreground' is global input into whatever is frontmost. Pass foreground: true to declare it; Mako still verifies that this exact application and window are already frontmost and refuses otherwise. Background routes: fill or set_value for text, click(element_token) for a control, a page route for an Electron or Chromium app, invoke_menu with foreground: true for a menu shortcut.",
    }
  if (isBackgroundCmdChord(action, args) && args[FORCE_FLAG] !== true)
    return {
      code: "background-chord",
      message:
        "Background Command delivery has not passed exact-window acceptance for the installed driver. Nothing was posted. Use the menu item: invoke_menu({pid, window_id, path, foreground: true}); for text, fill or set_value; for a renderer, its page route; for an application whose own key handler reads the chord, pass force: true.",
    }
  return undefined
}

const deliverySchema = z.object({
  delivery: z.looseObject({ mode: z.string().optional() }).optional(),
  actual_delivery: z.string().optional(),
})

/** Whether a result says the driver delivered through the foreground. */
export function deliveredForeground(
  action: string,
  structuredContent: JsonObject | undefined
): boolean {
  if (FRONTING_ACTIONS.has(action)) return true
  const parsed = deliverySchema.safeParse(structuredContent)
  if (!parsed.success) return false
  return (
    parsed.data.delivery?.mode === "foreground" ||
    parsed.data.actual_delivery === "foreground"
  )
}
