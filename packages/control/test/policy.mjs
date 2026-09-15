import assert from "node:assert/strict"
import {
  deliveredForeground,
  keyRouteAdvice,
  refusalFor,
  withoutEscalationNudge,
} from "../dist/computer/index.js"

// Fronting is declared: invoke_menu, bring_to_front and foreground delivery
// need the flag; with it nothing is refused.
assert.equal(
  refusalFor("invoke_menu", { path: ["Edit"] }).code,
  "foreground-required"
)
assert.match(
  refusalFor("invoke_menu", {}).message,
  /restores the previous frontmost app/
)
assert.match(refusalFor("bring_to_front", {}).message, /leaves it in front/)
assert.equal(refusalFor("invoke_menu", { foreground: true }), undefined)
assert.equal(
  refusalFor("hotkey", { keys: ["shift", "left"], delivery_mode: "foreground" })
    .code,
  "foreground-required"
)
assert.equal(
  refusalFor("hotkey", {
    keys: ["cmd", "a"],
    delivery_mode: "foreground",
    foreground: true,
  }),
  undefined
)

// A background Cmd chord is refused before dispatch; force posts it; other
// chords and other actions pass.
const chord = refusalFor("hotkey", { keys: ["cmd", "a"] })
assert.equal(chord.code, "background-chord")
assert.match(chord.message, /Nothing was posted/)
assert.equal(
  refusalFor("press_key", { key: "a", modifiers: ["Command"] }).code,
  "background-chord"
)
assert.equal(
  refusalFor("hotkey", { keys: ["cmd", "a"], force: true }),
  undefined
)
assert.equal(refusalFor("hotkey", { keys: ["shift", "left"] }), undefined)
assert.equal(refusalFor("press_key", { key: "return" }), undefined)
assert.equal(refusalFor("type_text", { text: "x" }), undefined)
assert.equal(refusalFor("click", { element_token: "s00000001:1" }), undefined)

// The driver's nudge is stripped to its reason; a nudge with no reason goes.
assert.deepEqual(
  withoutEscalationNudge({
    effect: "unverifiable",
    escalation: {
      reason: "delivery_failed",
      target: "foreground",
      hint: 're-call with delivery_mode:"foreground"',
    },
  }),
  { effect: "unverifiable", escalation: { reason: "delivery_failed" } }
)
assert.deepEqual(
  withoutEscalationNudge({
    effect: "ok",
    escalation: { target: "foreground" },
  }),
  { effect: "ok" }
)
assert.deepEqual(withoutEscalationNudge({ effect: "ok" }), { effect: "ok" })

// Key verdicts: delivery_failed is unconfirmed (the driver reports it for
// chords that landed), an unverified combo is unverifiable, a confirmed key is nothing.
assert.equal(
  keyRouteAdvice({
    effect: "unverifiable",
    escalation: { reason: "delivery_failed" },
  }).status,
  "unconfirmed"
)
assert.equal(keyRouteAdvice({ effect: "unverifiable" }).status, "unverifiable")
assert.equal(keyRouteAdvice({ effect: "confirmed" }), undefined)

// What counts as having fronted.
assert.equal(deliveredForeground("invoke_menu", {}), true)
assert.equal(
  deliveredForeground("click", { delivery: { mode: "foreground" } }),
  true
)
assert.equal(
  deliveredForeground("click", { actual_delivery: "foreground" }),
  true
)
assert.equal(
  deliveredForeground("click", { delivery: { mode: "background" } }),
  false
)
assert.equal(deliveredForeground("click", undefined), false)
console.log("policy ok")
