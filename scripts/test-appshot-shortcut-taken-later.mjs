// The Appshot shortcut taken after it was set, live on this Mac, with
// nothing of the person's touched: the desktop client's own holder
// (electron/appshot-shortcut-electron.ts) in a bare Electron process of its
// own, and every "other app" a process this test starts and stops.
//
//   node --import tsx scripts/test-appshot-shortcut-taken-later.mjs [evidence-dir]
//
// It requires: keys another process takes exclusively after they were set
// are found by the next check (a wake), let go and reported as taken since,
// and held again by the check after that process quits (an unlock), when a
// press reaches the holder again; a change to a preferences domain (a
// test-only one, written through cfprefsd as System Settings writes its
// own) starts a check, first through its folder and then through the file
// cfprefsd replaced; a check while the keys' modifiers are down registers
// nothing and tries again; an app holding the same keys the usual way and
// coming to the front on a press is reported with its pid, once as a hint
// until dismissed; a press that nothing else reacts to clears that; and a
// panel that doesn't take focus is not seen (said, not hidden).
//
// Focus: the launcher stand-in comes to the front on two presses, as a
// launcher does, for about 350 ms each, then hides, which gives the front
// back to the app that had it. Nothing else takes focus. Keys pressed are
// only chords some process here holds, so none reaches the person's apps;
// the modifier check holds Control and Option for two seconds.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

/** A preferences domain of the test's own: its file is what the holder watches here, in place of System Settings'. */
const DOMAIN = "dev.mako.test-appshot-taken-later"
const DOMAIN_FILE = join(homedir(), "Library/Preferences", `${DOMAIN}.plist`)

if (process.versions.electron) void holderProcess()
else await check()

/** The Electron side: the client's holder, driven by JSON lines on stdin, answering on stdout. */
async function holderProcess() {
  const { app, powerMonitor } = await import("electron")
  const holder = await import(resolve("electron/appshot-shortcut-electron.ts"))
  const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  app.dock?.hide()
  await app.whenReady()
  let dismiss = null
  const held = new holder.AppshotShortcutHolder(() => say({ fired: Date.now() }), {
    onWatch: (watch) => say({ watch }),
    onHint: (hint) => {
      dismiss = hint.dismiss
      say({ hint: hint.text })
    },
    store: process.env.MAKO_TAKEN_LATER_STORE,
    systemShortcuts: DOMAIN_FILE,
  })
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line)
    if (command.set !== undefined) say({ state: await held.set(command.set) })
    // What macOS tells the client: a wake, an unlock, Mako coming to the front.
    if (command.emit === "resume" || command.emit === "unlock-screen") powerMonitor.emit(command.emit)
    if (command.emit === "did-become-active") app.emit(command.emit)
    if (command.dismiss) {
      dismiss?.()
      say({ dismissed: true })
    }
    if (command.quit) {
      held.dispose()
      app.exit(0)
    }
  }
}

async function check() {
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), "mako-appshot-taken-later-"))
  const evidence = resolve(process.argv[2] ?? join(root, "evidence"))
  await mkdir(evidence, { recursive: true })
  const electron = createRequire(import.meta.url)("electron")
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const jxa = (source, ...args) => run("/usr/bin/osascript", ["-l", "JavaScript", "-e", source, ...args])
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  /** Keyboard events as a keyboard posts them, at the HID level, where hot keys are matched. */
  const KEYS = `
ObjC.import("CoreGraphics");
function post(code, down, flags) {
  const event = $.CGEventCreateKeyboardEvent($(), code, down);
  $.CGEventSetFlags(event, flags);
  $.CGEventPost(0, event);
  delay(0.03);
}
function run(argv) {
  if (argv[0] === "hold") {
    post(59, true, 0x40000 | 0x1);
    post(58, true, 0x40000 | 0x80000 | 0x21);
    delay(Number(argv[1]));
    post(58, false, 0x40000 | 0x1);
    post(59, false, 0);
  } else {
    post(Number(argv[0]), true, Number(argv[1]));
    post(Number(argv[0]), false, Number(argv[1]));
  }
  return "posted";
}`
  const HYPER = 0x100000 | 0x80000 | 0x40000
  const press = (code) => jxa(KEYS, String(code), String(HYPER))

  /** Another app holding keys exclusively, as the window server holds Mission Control's: Carbon's kEventHotKeyExclusive. */
  const EXCLUSIVE = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("Carbon");
ObjC.import("unistd");
function run(argv) {
  const ref = Ref();
  console.log("held " + $.RegisterEventHotKey(Number(argv[0]), Number(argv[1]), { signature: 0x4f544852, id: 7 }, $.GetApplicationEventTarget(), 1, ref));
  while ($.getppid() !== 1) delay(0.1);
  return "";
}`

  /** A launcher, as Raycast or Alfred would be: the same keys held the usual way, and a window of its own on each press. */
  const launcherMain = join(root, "launcher.cjs")
  await writeFile(
    launcherMain,
    `const { app, globalShortcut, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(join(root, "launcher-data"))});
app.dock?.hide();
const mode = process.argv.at(-1);
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 420, height: 120, show: false, title: "Launcher stand-in", ...(mode === "panel" ? { type: "panel", focusable: false } : {}) });
  void window.loadURL("data:text/html,<body style='font:16px system-ui;padding:16px'>Launcher stand-in</body>");
  console.log("held " + globalShortcut.register("Control+Option+Command+K", () => {
    console.log("pressed " + Date.now());
    if (mode === "activate") { window.show(); app.focus({ steal: true }) }
    else if (mode === "panel") window.showInactive();
    setTimeout(() => { window.hide(); if (mode === "activate") app.hide() }, 350);
  }) + " pid " + process.pid);
});`,
  )
  const launcher = async (mode) => {
    const child = spawn(electron, [launcherMain, mode], { env, stdio: ["ignore", "pipe", "ignore"] })
    started.push(child)
    const lines = []
    createInterface({ input: child.stdout }).on("line", (line) => lines.push(line))
    for (let tries = 0; !lines.some((line) => line.startsWith("held")) && tries < 200; tries++) await wait(50)
    const [, ok, pid] = /held (\w+) pid (\d+)/.exec(lines.find((line) => line.startsWith("held")) ?? "") ?? []
    assert.equal(ok, "true", `the ${mode} launcher holds ⌃⌥⌘K`)
    return { child, pid: Number(pid), lines }
  }

  const started = []
  const results = { checks: [] }
  try {
    try {
      await run("/usr/bin/defaults", ["delete", DOMAIN])
    } catch {
      // Not there: as it should be.
    }
    await rm(DOMAIN_FILE, { force: true })

    const client = spawn(electron, [resolve("scripts/test-appshot-shortcut-taken-later.mjs")], {
      env: { ...env, NODE_OPTIONS: "--import tsx", MAKO_TAKEN_LATER_STORE: join(root, "appshot-shortcut.json") },
      stdio: ["pipe", "pipe", "pipe"],
    })
    started.push(client)
    const answers = []
    const hints = []
    const fired = []
    let watch = null
    createInterface({ input: client.stdout }).on("line", (line) => {
      if (!line.startsWith("{")) return
      const answer = JSON.parse(line)
      if (answer.fired) fired.push(answer.fired)
      else if (answer.watch) {
        watch = answer.watch
        for (const check of watch.checks) if (!results.checks.some((seen) => seen.at === check.at && seen.reason === check.reason)) results.checks.push(check)
      } else if (answer.hint) hints.push(answer.hint)
      else answers.push(answer)
    })
    client.stderr.on("data", () => {})
    const send = (command) => client.stdin.write(`${JSON.stringify(command)}\n`)
    const ask = async (command, timeoutMs = 15_000) => {
      send(command)
      const deadline = Date.now() + timeoutMs
      while (answers.length === 0) {
        if (Date.now() > deadline) throw new Error(`No answer to ${JSON.stringify(command)}`)
        await wait(50)
      }
      return answers.shift()
    }
    const until = async (label, predicate, timeoutMs = 12_000) => {
      const deadline = Date.now() + timeoutMs
      while (!(watch && predicate(watch))) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}; last watch ${JSON.stringify(watch)}`)
        await wait(50)
      }
      return watch
    }
    const firedAfter = async (before, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs
      while (fired.length <= before && Date.now() < deadline) await wait(50)
      return fired.length > before
    }

    /* Keys another process takes exclusively after they were set ---------------------- */

    const J = 38
    const set = await ask({ set: { kind: "keys", chord: "ctrl+alt+mod+j" } })
    assert.equal(set.state.state, "on")
    await until("the check made when the keys were set", (w) => w.checks[0]?.reason === "set" && w.checks[0].result === "clear")
    results.watchingWhileHeld = watch.watching
    assert.equal(watch.watching.activations, true, "apps coming to the front are watched while the keys are held")
    assert.equal(watch.watching.preferences, "folder", "the preferences file doesn't exist yet: its folder is watched for it")
    assert.ok(watch.next && watch.next > Date.now() + 50 * 60_000, "the next check is the hourly one")

    const exclusive = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", EXCLUSIVE, String(J), String(0x100 | 0x800 | 0x1000)], { stdio: ["ignore", "ignore", "pipe"] })
    started.push(exclusive)
    const heldLine = await new Promise((done, reject) => {
      exclusive.stderr.on("data", (chunk) => /held (-?\d+)/.test(String(chunk)) && done(String(chunk).trim()))
      setTimeout(() => reject(new Error("the exclusive holder didn't start")), 10_000)
    })
    assert.equal(heldLine, "held 0", "another process takes ⌃⌥⌘J exclusively while Mako holds it the usual way")
    const woke = Date.now()
    send({ emit: "resume" })
    const taken = await until("the wake's check finds the keys taken", (w) => w.state.state === "refused")
    results.takenLater = { state: taken.state, check: taken.checks[0], afterWakeMs: Date.now() - woke }
    assert.deepEqual(taken.state.clash, { by: "held" })
    assert.equal(taken.state.later, true)
    assert.equal(taken.state.reason, "Since you set it, macOS or another app took ⌃⌥⌘J for itself.")
    assert.equal(taken.checks[0].reason, "wake")
    assert.ok(Date.now() - woke >= 5_000, "a wake waits for the Mac to settle")

    exclusive.kill()
    await new Promise((done) => exclusive.once("exit", done))
    send({ emit: "unlock-screen" })
    const freed = await until("the unlock's check holds them again", (w) => w.state.state === "on")
    results.freedAgain = { check: freed.checks[0] }
    assert.equal(freed.checks[0].reason, "unlock")
    const beforeFreed = fired.length
    await press(J)
    results.pressAfterFreed = await firedAfter(beforeFreed)
    assert.ok(results.pressAfterFreed, "a press reaches Mako again")

    /* A check while the keys' modifiers are down ------------------------------------- */

    // A press a moment ago: the next check waits it out.
    await wait(3_200)
    send({ emit: "unlock-screen" })
    // The helper takes a few hundred milliseconds to start: the keys go down well before the check at 2 s.
    await wait(900)
    const holding = jxa(KEYS, "hold", "2")
    const busy = await until("a check finds the modifiers down", (w) => w.checks[0]?.result === "busy", 6_000)
    await holding
    results.busy = busy.checks[0]
    const retried = await until("the check tries again once they're up", (w) => w.checks[0]?.reason === "unlock" && w.checks[0].result === "clear" && w.checks[0].at > busy.checks[0].at, 8_000)
    results.retried = retried.checks[0]
    assert.equal(retried.state.state, "on", "Mako held the keys all along")

    /* System Settings' shortcuts changed (a test-only domain, written through cfprefsd) -- */

    const firstWrite = Date.now()
    await run("/usr/bin/defaults", ["write", DOMAIN, "Probe", "-int", "1"])
    const created = await until("a check after the file appeared", (w) => w.checks[0]?.reason === "preferences", 10_000)
    results.preferencesCreated = { check: created.checks[0], afterWriteMs: created.checks[0].at - firstWrite }
    await until("the file itself is watched now", (w) => w.watching.preferences === "file", 3_000)
    await wait(1_000)
    const secondWrite = Date.now()
    await run("/usr/bin/defaults", ["write", DOMAIN, "Probe", "-int", "2"])
    const changed = await until("a check after cfprefsd replaced the file", (w) => w.checks[0]?.reason === "preferences" && w.checks[0].at > secondWrite, 10_000)
    results.preferencesChanged = { check: changed.checks[0], afterWriteMs: changed.checks[0].at - secondWrite }
    assert.equal(changed.watching.preferences, "file")

    /* Another app that reacts to the same press -------------------------------------- */

    const K = 40
    const activate = await launcher("activate")
    assert.equal((await ask({ set: { kind: "keys", chord: "ctrl+alt+mod+k" } })).state.state, "on")
    await wait(800)
    const pressedAt = Date.now()
    await press(K)
    const reacted = await until("the launcher came to the front after the press", (w) => w.press && w.press.at >= pressedAt - 50 && w.press.evidence !== undefined, 4_000)
    results.launcherActivate = { press: reacted.press, evidence: reacted.evidence, hints: [...hints] }
    assert.equal(reacted.press.evidence?.pid, activate.pid, "the app named is the launcher")
    assert.ok(reacted.press.evidence.afterMs < 500)
    assert.equal(hints.length, 1, "one hint, for the card")
    assert.match(hints[0], /came to the front too\. It may also use ⌃⌥⌘K\.$/)
    await ask({ dismiss: true })
    const kept = JSON.parse(await readFile(join(root, "appshot-shortcut.json"), "utf8"))
    assert.equal(kept.dismissedHints.length, 1, "the dismissal is kept in the client's data")
    await wait(1_200)
    const againAt = Date.now()
    await press(K)
    await until("the second press seen", (w) => w.press && w.press.at >= againAt - 50, 4_000)
    assert.equal(watch.press.evidence?.pid, activate.pid, "the launcher reacted again")
    assert.equal(hints.length, 1, "and no hint: it was dismissed")
    activate.child.kill()
    await wait(800)

    // A launcher showing a panel that never takes focus: nothing comes to the front.
    const panel = await launcher("panel")
    const panelAt = Date.now()
    await press(K)
    await wait(300)
    const panelPressed = panel.lines.some((line) => line.startsWith("pressed"))
    const unseen = await until("the panel press read", (w) => w.press && w.press.at >= panelAt - 50, 4_000)
    results.launcherPanel = { launcherPressed: panelPressed, evidence: unseen.press.evidence, keptEvidence: unseen.evidence }
    assert.ok(panelPressed, "the panel launcher was told of the press")
    assert.equal(unseen.press.evidence, null, "a panel that doesn't take focus isn't seen: the limit of this evidence")
    assert.equal(unseen.evidence, null, "and this press, which nothing came forward after, clears what the launcher's left")
    panel.child.kill()

    await ask({ quit: true }, 3000).catch(() => undefined)
    results.checkMs = results.checks.filter((check) => check.result !== "busy").map((check) => check.ms)
    await writeFile(join(evidence, "taken-later-results.json"), `${JSON.stringify(results, null, 2)}\n`)
    console.log(
      `Appshot shortcut taken later, live: keys taken exclusively after they were set found by the wake's check ${results.takenLater.afterWakeMs} ms after the wake and let go, held again after an unlock and a press reached Mako; a check with the modifiers down registered nothing and tried again 3 s later; the preferences domain's file appearing and changing each started a check (${results.preferencesCreated.afterWriteMs} and ${results.preferencesChanged.afterWriteMs} ms after the write); the launcher coming to the front ${results.launcherActivate.press.evidence.afterMs} ms after a press was named, hinted once and not again once dismissed; a panel that took no focus was not seen. Checks took ${Math.min(...results.checkMs)}–${Math.max(...results.checkMs)} ms. Evidence: ${evidence}`,
    )
  } finally {
    for (const child of started) if (child.exitCode === null) child.kill()
    try {
      await run("/usr/bin/defaults", ["delete", DOMAIN])
    } catch {
      // Already gone.
    }
    if (existsSync(DOMAIN_FILE)) await rm(DOMAIN_FILE, { force: true })
  }
}
