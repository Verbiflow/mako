import assert from "node:assert/strict"
import {
  chordGlyphs,
  evidenceHint,
  evidenceSentence,
  laterClashSentence,
  type AppshotCheckReason,
  type AppshotPressEvidence,
} from "@mako/host/contracts/appshot-shortcut"
import {
  CheckSchedule,
  HOURLY_MS,
  QUIET_AFTER_PRESS_MS,
  REACT_MS,
  appInfo,
  keptEvidence,
  reactingActivation,
  runningApplication,
  systemApp,
  type CheckOutcome,
} from "../electron/appshot-shortcut-watch.ts"

/**
 * When the Appshot shortcut is checked again after it was set, and what a
 * press says about another app (electron/appshot-shortcut-watch.ts), on a
 * clock of the test's own. The live side is
 * `scripts/test-appshot-shortcut-taken-later.mjs`; the measurements are in
 * docs/audits/2026-10-12/appshot-shortcut-clashes.md, "Taken later".
 */

/** A clock that only moves when the test says, running what fell due in order. */
function testClock() {
  let now = 1_000_000
  let timers: Array<{ at: number; run: () => void; live: boolean }> = []
  const settle = () => new Promise((done) => setImmediate(done))
  return {
    clock: {
      now: () => now,
      after(ms: number, run: () => void) {
        const timer = { at: now + ms, run, live: true }
        timers.push(timer)
        return () => {
          timer.live = false
        }
      },
    },
    get now() {
      return now
    },
    pending: () => timers.filter((timer) => timer.live).length,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        due.live = false
        due.run()
        await settle()
      }
      timers = timers.filter((timer) => timer.live)
      now = end
      await settle()
    },
  }
}

function schedule(options: { idle?: number; outcome?: (reason: AppshotCheckReason) => CheckOutcome } = {}) {
  const time = testClock()
  const runs: Array<{ reason: AppshotCheckReason; at: number }> = []
  let idle = options.idle ?? 600
  const checks = new CheckSchedule(
    time.clock,
    async (reason) => {
      runs.push({ reason, at: time.now })
      return options.outcome?.(reason) ?? "done"
    },
    () => idle,
  )
  return { time, runs, checks, setIdle: (seconds: number) => (idle = seconds) }
}

/* Requests close together are one check -------------------------------------------- */
{
  const { time, runs, checks } = schedule()
  checks.start()
  checks.request("preferences")
  await time.advance(500)
  // cfprefsd's second write of the same change.
  checks.request("preferences")
  await time.advance(1_400)
  assert.equal(runs.length, 0, "a burst of writes waits until they stop")
  await time.advance(200)
  assert.deepEqual(runs.map((run) => run.reason), ["preferences"], "and is one check")
}

/* A request that never stops still runs within ten seconds --------------------------- */
{
  const { time, runs, checks } = schedule()
  checks.start()
  for (let i = 0; i < 20; i++) {
    checks.request("preferences")
    await time.advance(1_000)
  }
  assert.ok(runs.length >= 1 && runs[0].at - 1_000_000 <= 10_000, "a check is never put off past ten seconds")
}

/* Several reasons are one check, recorded under the one that says most -------------- */
{
  const { time, runs, checks } = schedule()
  checks.start()
  checks.request("active")
  checks.request("wake")
  checks.request("asked")
  await time.advance(6_000)
  assert.deepEqual(runs.map((run) => run.reason), ["wake"])
}

/* Fresh checks aren't repeated for the reasons that come often ------------------------ */
{
  const { time, runs, checks } = schedule()
  checks.start()
  checks.checked(time.now)
  checks.request("asked")
  checks.request("active")
  await time.advance(5_000)
  assert.equal(runs.length, 0, "Settings opening or Mako coming forward right after a check checks nothing")
  checks.request("preferences")
  await time.advance(2_000)
  assert.deepEqual(runs.map((run) => run.reason), ["preferences"], "a change in System Settings always does")
  await time.advance(61_000)
  checks.request("asked")
  await time.advance(400)
  assert.equal(runs.at(-1)?.reason, "asked", "asked again a minute later, it checks")
  checks.request("active")
  await time.advance(2_000)
  assert.equal(runs.length, 2, "Mako coming forward within ten minutes of a check doesn't")
}

/* Nothing is checked right after a press -------------------------------------------- */
{
  const { time, runs, checks } = schedule()
  checks.start()
  checks.pressed(time.now)
  checks.request("preferences")
  await time.advance(1_600)
  assert.equal(runs.length, 0, "the person is using the keys")
  await time.advance(QUIET_AFTER_PRESS_MS)
  assert.equal(runs.length, 1, "it runs once they've been quiet")
  assert.ok(runs[0].at >= 1_000_000 + QUIET_AFTER_PRESS_MS)
}

/* Busy: the keys' modifiers were down, so it tries again, five times at most ---------- */
{
  let busy = 2
  const { time, runs, checks } = schedule({ outcome: () => (busy-- > 0 ? "busy" : "done") })
  checks.start()
  checks.request("wake")
  await time.advance(5_000)
  await time.advance(3_000)
  await time.advance(3_000)
  assert.equal(runs.length, 3, "two busy tries, then the check")
  const always = schedule({ outcome: () => "busy" })
  always.checks.start()
  always.checks.request("preferences")
  await always.time.advance(60_000)
  assert.equal(always.runs.length, 6, "a first try and five more, then it waits for the next reason")
}

/* Hourly, only while the Mac is idle ------------------------------------------------- */
{
  const { time, runs, checks, setIdle } = schedule({ idle: 5 })
  checks.start()
  assert.equal(checks.next(), time.now + HOURLY_MS)
  await time.advance(HOURLY_MS)
  assert.equal(runs.length, 0, "someone is typing: not now")
  assert.equal(checks.next(), time.now + 5 * 60_000, "it looks again in five minutes")
  setIdle(120)
  await time.advance(5 * 60_000)
  assert.deepEqual(runs.map((run) => run.reason), ["hourly"])
  assert.equal(checks.next(), time.now + HOURLY_MS, "and the next hour is armed")
}

/* A check that ran for another reason resets the hour --------------------------------- */
{
  const { time, runs, checks } = schedule()
  checks.start()
  await time.advance(HOURLY_MS - 60_000)
  checks.request("preferences")
  await time.advance(2_000)
  await time.advance(60_000)
  assert.deepEqual(runs.map((run) => run.reason), ["preferences"], "no hourly check a minute after another")
}

/* A request during a check runs after it ---------------------------------------------- */
{
  const time = testClock()
  const runs: AppshotCheckReason[] = []
  let finish: () => void = () => {}
  const checks = new CheckSchedule(
    time.clock,
    (reason) => {
      runs.push(reason)
      return new Promise((done) => (finish = () => done("done")))
    },
    () => 600,
  )
  checks.start()
  checks.request("wake")
  await time.advance(5_000)
  checks.request("preferences")
  finish()
  await time.advance(0)
  await time.advance(2_000)
  assert.deepEqual(runs, ["wake", "preferences"])
}

/* Stopped, nothing runs and no timer is left ------------------------------------------ */
{
  const { time, runs, checks } = schedule()
  checks.start()
  checks.request("preferences")
  checks.stop()
  await time.advance(HOURLY_MS * 2)
  assert.equal(runs.length, 0)
  assert.equal(time.pending(), 0, "stopping cancels every timer")
  checks.request("preferences")
  await time.advance(5_000)
  assert.equal(runs.length, 0, "a request while stopped is ignored")
}

/* What a press says about another app ------------------------------------------------- */
{
  const press = { at: 5_000, frontPid: 100 }
  const own = new Set([42])
  assert.deepEqual(reactingActivation(press, [{ at: 5_002, pid: 300, bundleId: "com.example.launcher" }], own), { at: 5_002, pid: 300, bundleId: "com.example.launcher" }, "an app in front 2 ms after the press")
  assert.equal(reactingActivation(press, [{ at: 4_990, pid: 300, bundleId: null }], own), null, "before the press: the person switched")
  assert.equal(reactingActivation(press, [{ at: 5_000 + REACT_MS + 1, pid: 300, bundleId: null }], own), null, "too long after")
  assert.equal(reactingActivation(press, [{ at: 5_100, pid: 42, bundleId: null }], own), null, "Mako, brought forward after an Appshot")
  assert.equal(reactingActivation(press, [{ at: 5_100, pid: 100, bundleId: null }], own), null, "the app already in front")
  assert.equal(
    reactingActivation(press, [{ at: 5_050, pid: 42, bundleId: null }, { at: 5_080, pid: 301, bundleId: null }], own)?.pid,
    301,
    "the first one that isn't Mako",
  )
}
{
  assert.equal(systemApp("/System/Library/CoreServices/Finder.app"), true)
  assert.equal(systemApp("/System/Library/CoreServices/UserNotificationCenter.app"), true)
  assert.equal(systemApp("/usr/libexec/universalaccessd"), true)
  assert.equal(systemApp("/Applications/Raycast.app"), false)
  assert.equal(systemApp("/System/Applications/Notes.app"), false, "an app a person opens, though Apple's")
  assert.equal(systemApp(null), false)
}
{
  const evidence = (pid: number): AppshotPressEvidence => ({ app: "Launcher", bundleId: "com.example.launcher", pid, afterMs: 2, shortcut: { kind: "keys", chord: "ctrl+shift+2" } })
  assert.deepEqual(keptEvidence(null, evidence(300), 100), evidence(300), "found replaces")
  assert.equal(keptEvidence(evidence(300), null, 100), null, "a press nothing came forward after clears it")
  assert.deepEqual(keptEvidence(evidence(300), null, 300), evidence(300), "unless that app was already in front, so it couldn't come forward")
}
{
  assert.deepEqual(runningApplication("<NSRunningApplication: 0x11400ea89d0 (com.google.Chrome - 24245) LSASN:{hi=0x0;lo=0x8f81f79}>"), { pid: 24245, bundleId: "com.google.Chrome" })
  assert.deepEqual(runningApplication("<NSRunningApplication: 0x11400ea89d0 ((null) - 18174) LSASN:{hi=0x0;lo=0xb83b830}>"), { pid: 18174, bundleId: null }, "an app without a bundle id")
  assert.equal(runningApplication("something else"), null)
  assert.equal(runningApplication("<NSRunningApplication: 0x1 (com.example - 0) LSASN:{}>"), null)
  assert.deepEqual(appInfo('"LSDisplayName"="Raycast"\n"LSBundlePath"="/Applications/Raycast.app"\n"CFBundleIdentifier"="com.raycast.macos"\n'), {
    name: "Raycast",
    bundlePath: "/Applications/Raycast.app",
    bundleId: "com.raycast.macos",
  })
  assert.deepEqual(appInfo(""), { name: null, bundlePath: null, bundleId: null })
}

/* The words ----------------------------------------------------------------------------- */
{
  assert.equal(chordGlyphs("ctrl+shift+2"), "⌃⇧2")
  assert.equal(chordGlyphs("mod+alt+arrowup"), "⌘⌥↑")
  assert.equal(laterClashSentence({ by: "held" }, "⌃⇧2"), "Since you set it, macOS or another app took ⌃⇧2 for itself.")
  assert.equal(laterClashSentence({ by: "macos", name: "Mission Control" }, "⌃↑"), "Since you set it, ⌃↑ became the shortcut for Mission Control in System Settings.")
  assert.equal(laterClashSentence({ by: "macos", name: null }, "⌥⌘M"), "Since you set it, ⌥⌘M became a macOS shortcut.")
  const chord: AppshotPressEvidence = { app: "Raycast", bundleId: "com.raycast.macos", pid: 300, afterMs: 2, shortcut: { kind: "keys", chord: "ctrl+shift+2" } }
  assert.equal(evidenceSentence(chord, "⌃⇧2"), "Another app may also react to ⌃⇧2: Raycast came to the front right after you pressed it.")
  assert.equal(evidenceSentence({ ...chord, shortcut: { kind: "modifiers", modifier: "shift" } }, "both Shift keys"), "Another app may also react to both Shift keys: Raycast came to the front right after you pressed them.")
  assert.equal(evidenceHint(chord, "⌃⇧2"), "Raycast came to the front too. It may also use ⌃⇧2.")
}

console.log("Appshot shortcut watch: checks after it was set coalesce, skip when fresh, wait out a press, retry busy keys five times, run hourly only while idle and stop cleanly; a press's evidence is another app (not Mako, not the one in front, not macOS's own) in front within 500 ms, kept until a press disagrees; words. Passes.")
