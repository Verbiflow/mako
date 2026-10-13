// The Appshot shortcut's clash detection on this Mac, live, with nothing of
// the person's touched: the desktop client's own holder
// (electron/appshot-shortcut-electron.ts) in a bare Electron process of its
// own, and the "other apps" are processes this test starts and stops.
//
//   node --import tsx scripts/test-appshot-shortcut-clashes.mjs [evidence-dir]
//
// It requires: keys another process holds exclusively are refused as held,
// and the same keys are held once that process quits, and a press of them
// reaches the holder; keys another app holds the usual way can't be told
// apart (recorded: both are told of the press); a shortcut macOS has on is
// refused by name, one it has off is free; one of Carbon's hidden ones is
// refused as macOS's; every shortcut read from the preferences agrees with
// Carbon's own list; and both Shift keys reach the holder. It takes no
// focus. Only keys some process here holds are ever pressed, so no press
// reaches the person's apps but the Shift keys, which type nothing.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

// Electron emits ready only once its main module has finished evaluating, so the holder isn't awaited here.
if (process.versions.electron) void holderProcess()
else await check()

/** The Electron side: the client's holder, driven by JSON lines on stdin, answering on stdout. */
async function holderProcess() {
  const { app } = await import("electron")
  const holder = await import(resolve("electron/appshot-shortcut-electron.ts"))
  const { chordClash } = await import("@mako/host/contracts/appshot-shortcut")
  const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  app.dock?.hide()
  await app.whenReady()
  const held = new holder.AppshotShortcutHolder(() => say({ fired: true }))
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line)
    if (command.set !== undefined) say({ state: await held.set(command.set) })
    if (command.system) {
      const system = await holder.readSystemShortcuts()
      say({ system, clashes: Object.fromEntries(command.system.map((chord) => [chord, chordClash(chord, system)])) })
    }
    if (command.quit) {
      held.dispose()
      app.exit(0)
    }
  }
}

async function check() {
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), "mako-appshot-clashes-"))
  const evidence = resolve(process.argv[2] ?? join(root, "evidence"))
  await mkdir(evidence, { recursive: true })
  const electron = createRequire(import.meta.url)("electron")
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const jxa = (source, ...args) => run("/usr/bin/osascript", ["-l", "JavaScript", "-e", source, ...args])

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
  if (argv[0] === "shifts") {
    post(56, true, 0x20000 | 0x2);
    post(60, true, 0x20000 | 0x2 | 0x4);
    delay(0.15);
    post(60, false, 0x20000 | 0x2);
    post(56, false, 0);
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

  /** Carbon's own list of the system's shortcuts, the oracle the preferences are checked against. */
  const SYMBOLIC = `
ObjC.import("Carbon");
function run() {
  const ref = Ref();
  $.CopySymbolicHotKeys(ref);
  const list = ObjC.castRefToObject(ref[0]);
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const entry = list.objectAtIndex(i);
    out.push({ keyCode: ObjC.unwrap(entry.objectForKey("kHISymbolicHotKeyCode")), modifiers: ObjC.unwrap(entry.objectForKey("kHISymbolicHotKeyModifiers")), enabled: Boolean(ObjC.unwrap(entry.objectForKey("kHISymbolicHotKeyEnabled"))) });
  }
  return JSON.stringify(out);
}`

  const started = []
  const results = {}
  try {
    // The holder, in Electron, reading TypeScript through tsx as the desk's scripts do.
    const env = { ...process.env, NODE_OPTIONS: "--import tsx" }
    delete env.ELECTRON_RUN_AS_NODE
    const client = spawn(electron, [resolve("scripts/test-appshot-shortcut-clashes.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] })
    started.push(client)
    const answers = []
    let waiting = null
    createInterface({ input: client.stdout }).on("line", (line) => {
      if (!line.startsWith("{")) return
      const answer = JSON.parse(line)
      if (answer.fired) results.fired = (results.fired ?? 0) + 1
      else answers.push(answer)
      waiting?.()
    })
    client.stderr.on("data", () => {})
    const ask = async (command, timeoutMs = 15_000) => {
      client.stdin.write(`${JSON.stringify(command)}\n`)
      const deadline = Date.now() + timeoutMs
      while (answers.length === 0) {
        if (Date.now() > deadline) throw new Error(`No answer to ${JSON.stringify(command)}`)
        await new Promise((done) => {
          waiting = done
          setTimeout(done, 200)
        })
      }
      return answers.shift()
    }
    const fired = async (before, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs
      while ((results.fired ?? 0) <= before && Date.now() < deadline) await wait(50)
      return (results.fired ?? 0) > before
    }
    /** How long each answer took: a chord's checks (the preferences, the probe) run before it is held. */
    results.answerMs = []
    const set = async (shortcut) => {
      const started = Date.now()
      const { state } = await ask({ set: shortcut })
      results.answerMs.push({ shortcut: shortcut.kind === "keys" ? shortcut.chord : `both ${shortcut.modifier}`, state: state.state, ms: Date.now() - started })
      return state
    }

    /* Keys another process holds exclusively ------------------------------------------ */

    const J = 38
    const exclusive = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", EXCLUSIVE, String(J), String(0x100 | 0x800 | 0x1000)], { stdio: ["ignore", "ignore", "pipe"] })
    started.push(exclusive)
    const heldLine = await new Promise((done, reject) => {
      exclusive.stderr.on("data", (chunk) => /held (-?\d+)/.test(String(chunk)) && done(String(chunk).trim()))
      setTimeout(() => reject(new Error("the exclusive holder didn't start")), 10_000)
    })
    results.exclusiveHolder = heldLine
    assert.equal(heldLine, "held 0", "the other process holds ⌃⌥⌘J exclusively")
    results.heldElsewhere = await set({ kind: "keys", chord: "ctrl+alt+mod+j" })
    assert.equal(results.heldElsewhere.state, "refused")
    assert.deepEqual(results.heldElsewhere.clash, { by: "held" }, "refused as held, though Electron's registration would have said yes")
    exclusive.kill()
    await new Promise((done) => exclusive.once("exit", done))
    results.afterRelease = await set({ kind: "keys", chord: "ctrl+alt+mod+j" })
    assert.equal(results.afterRelease.state, "on", "Try again holds the keys once the other process let them go")
    const before = results.fired ?? 0
    await press(J)
    results.pressReachedHolder = await fired(before)
    assert.ok(results.pressReachedHolder, "a press of the keys reaches the holder: what Settings' check reports")

    /* Keys another app holds the usual way ------------------------------------------- */

    const K = 40
    const sharedMain = join(root, "shared.cjs")
    await writeFile(
      sharedMain,
      `const { app, globalShortcut } = require("electron");
app.setPath("userData", ${JSON.stringify(join(root, "shared-data"))});
app.dock?.hide();
app.whenReady().then(() => {
  console.log("held " + globalShortcut.register("Control+Option+Command+K", () => console.log("fired")));
});`,
    )
    const sharedEnv = { ...process.env }
    delete sharedEnv.ELECTRON_RUN_AS_NODE
    const shared = spawn(electron, [sharedMain], { env: sharedEnv, stdio: ["ignore", "pipe", "ignore"] })
    started.push(shared)
    const sharedOut = []
    shared.stdout.on("data", (chunk) => sharedOut.push(String(chunk)))
    for (let tries = 0; !/held/.test(sharedOut.join("")) && tries < 200; tries++) await wait(50)
    assert.match(sharedOut.join(""), /held true/)
    results.sharedElsewhere = await set({ kind: "keys", chord: "ctrl+alt+mod+k" })
    assert.equal(results.sharedElsewhere.state, "on", "keys another app registered the usual way can't be seen from a registration")
    const beforeShared = results.fired ?? 0
    // The holder takes presses closer together than 700 ms as one.
    await wait(800)
    await press(K)
    results.sharedPressReachedHolder = await fired(beforeShared)
    await wait(300)
    results.sharedPressReachedOtherApp = /fired/.test(sharedOut.join(""))
    assert.ok(results.sharedPressReachedHolder && results.sharedPressReachedOtherApp, "both are told of the press: the clash Settings' recorder catches, by the keys never arriving")
    shared.kill()

    /* macOS's own, from the preferences and from Carbon ------------------------------ */

    const carbon = JSON.parse((await jxa(SYMBOLIC)).stdout)
    const { carbonHotKeyOf, symbolicHotKeyOn } = await import("@mako/host/contracts/macos-shortcuts")
    const { system, clashes } = await ask({ system: ["ctrl+arrowup", "mod+shift+4", "mod+space", "mod+alt+m"] })
    // Every shortcut read from the preferences and the defaults is in Carbon's list, on or off alike.
    const listed = system.filter((shortcut) => shortcut.id !== null)
    const disagree = listed.filter((shortcut) => {
        const wanted = carbonHotKeyOf(shortcut.chord)
        return !carbon.some((entry) => entry.keyCode === wanted.keyCode && (entry.modifiers & ~0x20000) === wanted.modifiers && entry.enabled === shortcut.enabled)
      })
    results.preferences = { read: listed.length, agreeWithCarbon: listed.length - disagree.length, disagree }
    assert.deepEqual(disagree, [], "the preferences laid over the defaults are what Carbon reports")
    results.systemClashes = clashes
    const on = (chord) => symbolicHotKeyOn(chord, carbon)
    for (const chord of ["ctrl+arrowup", "mod+shift+4", "mod+space"])
      assert.equal(Boolean(clashes[chord]), on(chord), `${chord} is refused exactly when macOS has it on`)
    if (on("ctrl+arrowup")) {
      assert.deepEqual(clashes["ctrl+arrowup"], { by: "macos", name: "Mission Control" })
      // Never pressed: the holder refuses it before registering anything.
      results.missionControl = await set({ kind: "keys", chord: "ctrl+arrowup" })
      assert.deepEqual(results.missionControl.clash, { by: "macos", name: "Mission Control" })
    }
    if (on("mod+alt+m") && !clashes["mod+alt+m"]) {
      // One of the shortcuts System Settings doesn't list, found by the probe's Carbon list.
      results.hidden = await set({ kind: "keys", chord: "mod+alt+m" })
      assert.deepEqual(results.hidden.clash, { by: "macos", name: null })
    }

    /* Both Shift keys ------------------------------------------------------------------ */

    results.pair = await set({ kind: "modifiers", modifier: "shift" })
    assert.equal(results.pair.state, "on")
    const beforePair = results.fired ?? 0
    await wait(800)
    await jxa(KEYS, "shifts")
    results.pairReachedHolder = await fired(beforePair)
    assert.ok(results.pairReachedHolder, "both Shift keys reach the holder's helper")

    await ask({ quit: true }, 3000).catch(() => undefined)
    await writeFile(join(evidence, "clash-results.json"), `${JSON.stringify(results, null, 2)}\n`)
    console.log(
      `Appshot shortcut clashes live: keys held exclusively by another process refused as held and held once it quit (a press then reached Mako); keys another app registered the usual way taken by both (${results.sharedPressReachedOtherApp ? "both were told" : "?"}), undetectable by registration; ${results.preferences.agreeWithCarbon}/${results.preferences.read} of macOS's shortcuts read from the preferences agree with Carbon's list; ${results.missionControl ? "⌃↑ refused as Mission Control" : "⌃↑ is off here"}; ${results.hidden ? "⌥⌘M refused as a macOS shortcut" : "no hidden shortcut checked"}; both Shift keys reached Mako. Evidence: ${evidence}`,
    )
  } finally {
    for (const child of started) if (child.exitCode === null) child.kill()
  }
}
