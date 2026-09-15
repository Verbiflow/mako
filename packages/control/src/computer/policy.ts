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
 * about the auth-message envelope. So background keyboard is a route for
 * native Cocoa fields only, and the wrapper says so on the result
 * (`keyRouteAdvice`) instead of leaving "unverifiable" to be read as
 * "probably fine".
 */
export const BACKGROUND_INPUT_LADDER = [
  {
    route: "accessibility",
    action:
      "set_value, click(element_token) with action press/pick/confirm/open",
    when: "An observed element exposes the value or action you need. Background, no focus change, verifiable by read-back on the same control. This is how to write into a backgrounded Electron or Chromium field: set_value replaces its text where a keyboard would select-all and retype.",
  },
  {
    route: "window-pointer",
    action:
      "click, double_click, right_click, drag, scroll with x,y (or from_zoom)",
    when: "Window-local screenshot pixels from this window's latest capture (element frames are screen points: subtract window_bounds and multiply by screenshot_scale). Posted to the window's pid without fronting it. Electron and Chromium windows ignore background scrolling on macOS.",
  },
  {
    route: "menu",
    action: "invoke_menu({pid, window_id, path})",
    when: "The intent is a menu item or its shortcut (Undo, Save, Close Window, Select All) and no element action does it. Resolves the exact path through accessibility and fails closed. The driver briefly fronts the application to invoke the item and restores the previous frontmost app itself; expect a few seconds on a menu it has not walked before.",
  },
  {
    route: "pid-keyboard",
    action:
      "type_text, press_key, hotkey (delivery_mode background, the default)",
    when: "Native Cocoa fields only. A Chromium or Electron renderer that is not frontmost drops every posted key: the result carries escalation.reason 'delivery_failed' and Mako marks it not-delivered. Do not retry it; use set_value, invoke_menu, Mako browser tools for a page, or explicit foreground. A combo never focuses a field and is never driver-verifiable: read the field back.",
  },
  {
    route: "foreground",
    action: "any input action with delivery_mode:'foreground' and window_id",
    when: "The only keyboard route into a renderer, and the route for a native app that ignores a background combo when no menu path exists. Foreground input is global input: Mako first checks that this exact application and window are already frontmost and refuses otherwise. It never escalates on its own; the user or the program brings the window forward deliberately.",
  },
] as const

/** Keyboard tools: the driver cannot read a combo back and drops keys on backgrounded renderers. */
export const KEYBOARD_TOOLS: ReadonlySet<string> = new Set([
  "hotkey",
  "press_key",
  "type_text",
])

export const KEY_ROUTE_ADVICE = {
  notDelivered: {
    status: "not-delivered",
    reason:
      "The driver reports these key events were not delivered: a Chromium or Electron renderer that is not frontmost drops background keyboard input. Nothing landed; do not retry the same call.",
    routes:
      "Write the field with set_value (background, verifiable). Perform a menu item or its shortcut with invoke_menu({pid, window_id, path}); the driver fronts the app briefly and restores the previous frontmost app. Drive a page inside a browser with Mako browser tools. Keyboard reaches a renderer only with delivery_mode:'foreground' once its window is already frontmost; Mako never escalates on its own.",
  },
  unverifiable: {
    status: "unverifiable",
    reason:
      "The driver cannot read a key combo back. Read the field or window state (view, get_window_state, verify_state) before deciding it landed.",
    routes:
      "If the combo stands for a menu item, invoke_menu({pid, window_id, path}) performs and verifies it. A combo never focuses a field: establish focus first. delivery_mode:'foreground' is explicit and requires the window to be frontmost already.",
  },
} as const

const keyOutcomeSchema = z.object({
  effect: z.string().optional(),
  escalation: z.looseObject({ reason: z.string().optional() }).optional(),
})

/**
 * Mako's reading of a keyboard result the driver could not confirm: dropped
 * outright (`delivery_failed`) or merely unverified, and in both cases the
 * routes that can do the job. Undefined when the driver confirmed it.
 */
export function keyRouteAdvice(
  structuredContent: JsonObject | undefined
): (typeof KEY_ROUTE_ADVICE)[keyof typeof KEY_ROUTE_ADVICE] | undefined {
  const outcome = keyOutcomeSchema.safeParse(structuredContent)
  if (!outcome.success) return undefined
  if (outcome.data.escalation?.reason === "delivery_failed")
    return KEY_ROUTE_ADVICE.notDelivered
  if (outcome.data.effect === "unverifiable")
    return KEY_ROUTE_ADVICE.unverifiable
  return undefined
}
