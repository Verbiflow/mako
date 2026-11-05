import assert from "node:assert/strict"
import { test } from "node:test"
import { BUDGETS, CASES, deviceLabel, type MobileCase } from "./mobile-behavior/cases.ts"
import { caseVerdict, failsRun, gradeFrames, gradeReadings, judge, ReadingSchema, verdict, type Frame } from "./mobile-behavior/grade.ts"

/**
 * The mobile-behavior grade, from frames and readings made here: a transcript that follows its end smoothly, one that
 * is pushed back, one that teleports, frames over budget, a reader's place that drifts, and the web client's own
 * readings. Then each kind of case's verdict, and the cases as data.
 */

/** Frames every 16 ms, each turn's top given by `top(turn, frame)`. */
function frames(count: number, top: (turn: number, frame: number) => number, options: { everyMs?: (frame: number) => number; fromEnd?: (frame: number) => number } = {}): Frame[] {
  let at = 0
  return Array.from({ length: count }, (_, frame) => {
    at += frame === 0 ? 0 : (options.everyMs?.(frame) ?? 16)
    return { at, fromEnd: options.fromEnd?.(frame) ?? 0, rows: [0, 1, 2].map((turn) => [`t${turn}`, top(turn, frame)] as const) }
  })
}

test("following the end moves turns only up, never back, and keeps the end in view", () => {
  const graded = gradeFrames(frames(120, (turn, frame) => 600 + turn * 200 - frame * 3))
  assert.deepEqual([graded.backwardPx, graded.teleports, graded.maxFromEndPx, graded.slowFramePct], [0, 0, 0, 0])
})

test("content pushed back down while the reader follows is backward movement", () => {
  const graded = gradeFrames(frames(60, (turn, frame) => 600 + turn * 200 - frame * 3 + (frame >= 30 ? 30 : 0)))
  assert.equal(graded.backwardPx, 27)
  const following = CASES.find((behavior) => behavior.id === "follows-the-end-while-streaming")
  assert.ok(following)
  assert.equal(judge(following, graded).find((entry) => entry.metric === "backwardPx")?.pass, false)
})

test("a turn that moves 400 px in one frame teleported", () => {
  const graded = gradeFrames(frames(30, (turn, frame) => 300 + turn * 200 - (frame === 15 ? 0 : frame >= 15 ? 450 : 0)))
  assert.equal(graded.teleports, 1)
})

test("frames slower than 25 ms count against the budget, and the end is measured after the first half second", () => {
  const graded = gradeFrames(frames(41, () => 100, { everyMs: (frame) => (frame % 10 === 0 ? 40 : 16), fromEnd: (frame) => (frame < 5 ? 900 : 120) }))
  assert.equal(graded.slowFramePct, 10)
  assert.equal(graded.maxFromEndPx, 120)
})

test("a reader's place drifting is measured from the first frame sampled", () => {
  const graded = gradeFrames(frames(20, (turn, frame) => 100 + turn * 200 + (frame > 10 ? 3 : 0)))
  assert.equal(graded.driftPx, 3)
  assert.equal(graded.shiftPx, 3)
})

test("the web client's readings, as the page says them, give the newest turn's time and dictation's stop", () => {
  const said = [
    { name: "web.page", props: { width: 402 } },
    { name: "web.thread-open", props: { newestMs: 180, from: "kept" } },
    { name: "web.thread-open", props: { newestMs: 240, from: "kept" } },
    { name: "web.dictation", props: { step: "stop-pressed" } },
    { name: "web.dictation", props: { step: "stopped", ms: 64 } },
  ]
  const metrics = gradeReadings(said.map((reading) => ReadingSchema.parse(reading)))
  assert.deepEqual(metrics, { newestMs: 240, dictationStopMs: 64 })
})

test("a guard fails on any measure over budget or unmeasured; a bad case is expected to fail until it's fixed", () => {
  const guard: MobileCase = { id: "g", kind: "guard", forms: ["phone"], experience: "", steps: [], measures: ["backwardPx", "teleports"] }
  assert.equal(verdict(guard, judge(guard, { backwardPx: 1, teleports: 0 })), "pass")
  assert.equal(verdict(guard, judge(guard, { backwardPx: 1 })), "fail")
  const bad: MobileCase = { ...guard, kind: "bad", budgets: { backwardPx: 0 } }
  assert.equal(verdict(bad, judge(bad, { backwardPx: 1, teleports: 0 })), "expected-fail")
  assert.equal(verdict(bad, judge(bad, { backwardPx: 0, teleports: 0 })), "fixed")
})

test("a case that streams while it samples, where nothing moved and the end didn't grow, proved nothing", () => {
  const held = CASES.find((behavior) => behavior.id === "holds-my-place-after-scrolling-up")
  assert.ok(held)
  const judged = judge(held, { driftPx: 0, teleports: 0, slowFramePct: 0 })
  assert.equal(verdict(held, judged, { frames: 120, ms: 2000, travelPx: 0, endGrewPx: 0 }), "unproven")
  assert.equal(verdict(held, judged, { frames: 120, ms: 2000, travelPx: 0, endGrewPx: 431 }), "pass")
  const still = CASES.find((behavior) => behavior.id === "a-still-page-stays-still")
  assert.ok(still)
  assert.equal(verdict(still, judge(still, { shiftPx: 0, teleports: 0 }), { frames: 90, ms: 1500, travelPx: 0, endGrewPx: 0 }), "pass")
})

test("a case's samples are judged together: half failing fails it, errors are left out, and more errors than grades is incomplete", () => {
  const guard: MobileCase = { id: "g", kind: "guard", forms: ["phone"], experience: "", steps: [], measures: ["backwardPx"] }
  assert.equal(caseVerdict(guard, ["pass", "pass", "fail"]), "pass")
  assert.equal(caseVerdict(guard, ["pass", "fail", "fail"]), "fail")
  assert.equal(caseVerdict(guard, ["pass", "fail"]), "fail", "half is enough to fail")
  assert.equal(caseVerdict(guard, ["pass", "error", "pass"]), "pass")
  assert.equal(caseVerdict(guard, ["pass", "error", "error"]), "incomplete")
  assert.equal(caseVerdict(guard, ["error"]), "incomplete")
  assert.equal(caseVerdict(guard, ["unproven", "unproven"]), "unproven")
  assert.equal(caseVerdict(guard, ["pass", "pass", "unproven"]), "pass")
  const bad: MobileCase = { ...guard, kind: "bad" }
  assert.equal(caseVerdict(bad, ["expected-fail", "fixed", "expected-fail"]), "expected-fail")
  assert.equal(caseVerdict(bad, ["fixed", "fixed", "expected-fail"]), "fixed")

  assert.equal(failsRun(guard, "incomplete"), true)
  assert.equal(failsRun(guard, "unproven"), true)
  assert.equal(failsRun(guard, "pass"), false)
  assert.equal(failsRun(bad, "expected-fail"), false)
  assert.equal(failsRun(bad, "incomplete"), false, "a bad case never fails the run")
})

test("every case is graded on measures with budgets, runs on a form, and has a distinct ID", () => {
  assert.equal(new Set(CASES.map((behavior) => behavior.id)).size, CASES.length)
  for (const behavior of CASES) {
    assert.ok(behavior.forms.length > 0, behavior.id)
    for (const metric of behavior.measures) assert.ok(metric in BUDGETS, `${behavior.id} measures ${metric}`)
  }
})

test("a summary names the device a case ran on as it is, not as its form is expected to be", () => {
  assert.equal(
    deviceLabel({ name: "Mako iPhone 18 Pro", type: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", runtime: "iOS 27.2" }),
    "Mako iPhone 18 Pro (iPhone 18 Pro, iOS 27.2)"
  )
  assert.equal(deviceLabel({ name: "Mako iPad Pro 13-inch (M5)", runtime: "iOS 27.2" }), "Mako iPad Pro 13-inch (M5) (iOS 27.2)")
  assert.equal(deviceLabel({ name: "WebKit at iPhone 17 Pro's size" }), "WebKit at iPhone 17 Pro's size")
})
