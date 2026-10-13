import { execFile, spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { app, globalShortcut, powerMonitor, systemPreferences } from "electron"
import { z } from "zod"
import {
  MODIFIER_NAMES,
  WATCH_CHECKS,
  acceleratorOf,
  chordClash,
  chordGlyphs,
  clashSentence,
  evidenceHint,
  laterClashSentence,
  sameShortcut,
  type AppshotCheckReason,
  type AppshotModifier,
  type AppshotPressEvidence,
  type AppshotShortcut,
  type AppshotShortcutCheck,
  type AppshotShortcutState,
  type AppshotShortcutWatch,
  type ChordClash,
} from "@mako/host/contracts/appshot-shortcut"
import {
  MACOS_DEFAULT_SHORTCUTS,
  carbonHotKeyOf,
  symbolicHotKeyOn,
  systemShortcuts,
  type SystemShortcut,
} from "@mako/host/contracts/macos-shortcuts"
import { hostLog } from "@mako/host/base/host-log"
import {
  CheckSchedule,
  REACT_MS,
  appInfo,
  keptEvidence,
  reactingActivation,
  runningApplication,
  systemApp,
  type Activation,
  type AppInfo,
  type CheckOutcome,
} from "./appshot-shortcut-watch.js"

/**
 * The Appshot shortcut, held by the desktop client for every window it has.
 *
 * A chord is Electron's `globalShortcut`, a Carbon hot key registered the
 * way every app's are, so registering never fails because another app or
 * macOS has the keys: both are told of each press, and a holder that
 * registered exclusively (the window server for Mission Control, ⌘Tab)
 * takes every press while Mako's registration still says yes. So before a
 * chord is registered it is checked against macOS's shortcuts as this Mac
 * has them (`com.apple.symbolichotkeys`, named) and probed by a helper that
 * registers it exclusively for a moment and lists Carbon's symbolic hot keys
 * (`CopySymbolicHotKeys`, the hidden ones too). Measured in
 * docs/audits/2026-10-12/appshot-shortcut-clashes.md. A modifier pair (both Shift keys) is no key
 * at all, so nothing can register it: a small JXA helper reads the
 * keyboard's modifier state twenty times a second and says `trigger` on the
 * moment both keys of the pair are down. Reading that state needs no
 * permission. The helper makes itself background-only before it touches
 * the window server, so it never gets a Dock tile, and leaves when its
 * parent does (its parent becomes launchd), so a crashed client leaves
 * nothing behind. T3 Code's SnapShot measured the same approach.
 *
 * Keys can be taken after they were set, and macOS says nothing when they
 * are. So while a chord is wanted, the client checks it again when
 * something could have taken it (`CheckSchedule`): System Settings writing
 * its shortcuts (a watch on their file), a wake or unlock, a window asking
 * for the keys again (Settings opening), Mako coming to the front, and
 * hourly while the Mac is idle. A check finding them taken lets them go
 * and says so; one finding them free again holds them again. Mako's own
 * registration stays while it checks: the probe's exclusive registration
 * lasts under a millisecond and is skipped while the keys' modifiers are
 * down, so it can't take a press. And another app that registered the keys
 * the usual way acts on the same press, which no check can see: the one
 * sign is that app coming to the front right after it, which the client
 * watches for while the keys are held and reports as evidence, never as a
 * certainty.
 */

/** Device-dependent flag bits for each modifier's left and right key (IOKit's NX_DEVICE*KEYMASK). */
const MODIFIER_MASKS = {
  shift: [0x2, 0x4],
  control: [0x1, 0x2000],
  option: [0x20, 0x40],
  command: [0x8, 0x10],
} as const satisfies Record<AppshotModifier, readonly [number, number]>

const POLLER = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const both = Number(argv[0]) | Number(argv[1]);
  let down = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const pressed = ($.CGEventSourceFlagsState(0) & both) === both;
    if (pressed && !down) console.log("trigger");
    down = pressed;
    delay(0.05);
  }
  return "orphaned";
}`

/**
 * Registers the chord exclusively for a moment: `eventHotKeyExistsErr`
 * (-9878) says another process holds it exclusively, which a shared
 * registration can't see. Then lists Carbon's symbolic hot keys. It holds
 * the keys for no longer than the call (0.15–0.3 ms measured), and never a
 * Dock tile. A press landing in that moment would be the probe's, not
 * Mako's, so with a guard (the keys' modifier flags) it registers nothing
 * while any of the keys' modifiers is down: a press can't begin and reach
 * its key within the next few milliseconds.
 */
const PROBE = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("Carbon");
ObjC.import("CoreGraphics");
function run(argv) {
  if (Number(argv[2]) && ($.CGEventSourceFlagsState(0) & Number(argv[2]))) return JSON.stringify({ busy: true });
  const ref = Ref();
  const status = $.RegisterEventHotKey(Number(argv[0]), Number(argv[1]), { signature: 0x4d4b4f50, id: 1 }, $.GetApplicationEventTarget(), 1, ref);
  if (status === 0) $.UnregisterEventHotKey(ref[0]);
  const listed = Ref();
  const symbolic = [];
  if ($.CopySymbolicHotKeys(listed) === 0) {
    const list = ObjC.castRefToObject(listed[0]);
    for (let i = 0; i < list.count; i++) {
      const entry = list.objectAtIndex(i);
      symbolic.push([ObjC.unwrap(entry.objectForKey("kHISymbolicHotKeyCode")), ObjC.unwrap(entry.objectForKey("kHISymbolicHotKeyModifiers")), Boolean(ObjC.unwrap(entry.objectForKey("kHISymbolicHotKeyEnabled")))]);
    }
  }
  return JSON.stringify({ status, symbolic });
}`
const HOT_KEY_EXISTS = -9878

const ProbeAnswer = z.union([
  z.object({ busy: z.literal(true) }),
  z.object({
    status: z.number(),
    symbolic: z.array(z.tuple([z.number(), z.number(), z.boolean()]).transform(([keyCode, modifiers, enabled]) => ({ keyCode, modifiers, enabled }))),
  }),
])

/** NSEvent's flag for each of Carbon's modifiers (cmdKey, controlKey, shiftKey, optionKey): what the probe's guard reads. */
const FLAG_OF_CARBON = [
  [0x100, 0x100000],
  [0x1000, 0x40000],
  [0x200, 0x20000],
  [0x800, 0x80000],
] as const

const run = promisify(execFile)

/** macOS's shortcuts as this Mac has them, or a new Mac's when its preferences can't be read. */
export async function readSystemShortcuts(): Promise<readonly SystemShortcut[]> {
  try {
    const { stdout } = await run("/bin/sh", ["-c", "/usr/bin/defaults export com.apple.symbolichotkeys - | /usr/bin/plutil -convert json -o - -"], { timeout: 4000 })
    return systemShortcuts(stdout)
  } catch (error) {
    // A Mac whose shortcuts were never changed has no such preferences: its defaults are the answer.
    hostLog("desktop", "appshot shortcut: macOS's shortcuts unread", { error: error instanceof Error ? error.message : String(error) })
    return MACOS_DEFAULT_SHORTCUTS
  }
}

/** What the checks say of a chord: a clash, nothing they can see (`failed` when the probe couldn't run), or `busy`: its modifiers were down, so nothing was registered. */
export type ChordCheck = { clash: ChordClash | null; failed: boolean } | { busy: true }

/**
 * The probe's word on `chord`: one of macOS's hidden shortcuts, held
 * exclusively elsewhere, or nothing it can see. With `guard`, nothing is
 * registered while any of the chord's modifiers is down.
 */
export async function probeChord(chord: string, guard = false): Promise<ChordCheck> {
  const hotKey = carbonHotKeyOf(chord)
  if (!hotKey) return { clash: null, failed: false }
  const flags = guard ? FLAG_OF_CARBON.reduce((all, [carbon, flag]) => (hotKey.modifiers & carbon ? all | flag : all), 0) : 0
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", PROBE, String(hotKey.keyCode), String(hotKey.modifiers), String(flags)], { timeout: 4000 })
    const answer = ProbeAnswer.parse(JSON.parse(stdout))
    if ("busy" in answer) return answer
    if (symbolicHotKeyOn(chord, answer.symbolic)) return { clash: { by: "macos", name: null }, failed: false }
    return { clash: answer.status === HOT_KEY_EXISTS ? { by: "held" } : null, failed: false }
  } catch (error) {
    // The probe only adds to what is known: without it, the registration and the recorder still speak.
    hostLog("desktop", "appshot shortcut: probe failed", { error: error instanceof Error ? error.message : String(error) })
    return { clash: null, failed: true }
  }
}

/** Every check of a chord: the rules over macOS's shortcuts as this Mac has them, then the probe. */
export async function checkChord(chord: string, guard = false): Promise<ChordCheck> {
  const clash = chordClash(chord, await readSystemShortcuts())
  return clash ? { clash, failed: false } : probeChord(chord, guard)
}

/** The app with this pid, as LaunchServices names it: about 10 ms, and no permission needed. */
async function appOf(pid: number): Promise<AppInfo> {
  try {
    const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "name", "-only", "bundlepath", "-only", "bundleid", String(pid)], { timeout: 2000 })
    return appInfo(stdout)
  } catch {
    return { name: null, bundlePath: null, bundleId: null }
  }
}

/** The app in front now, by pid, from LaunchServices. */
async function frontPid(): Promise<number | null> {
  try {
    const front = (await run("/usr/bin/lsappinfo", ["front"], { timeout: 2000 })).stdout.trim()
    if (!front) return null
    const pid = Number(/"pid"=(\d+)/.exec((await run("/usr/bin/lsappinfo", ["info", "-only", "pid", front], { timeout: 2000 })).stdout)?.[1])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Where System Settings keeps the shortcuts it changed. cfprefsd writes it by replacing the file, a second or three after the change. */
const SYSTEM_SHORTCUTS = join(homedir(), "Library/Preferences/com.apple.symbolichotkeys.plist")

/** Presses closer together than this are one press: a person holding both keys a moment longer. */
const REPEAT_MS = 700
const READY_MS = 5_000
/** App activations kept to read a press against: a press looks only REACT_MS ahead. */
const ACTIVATIONS_KEPT = 8
/** Hints dismissed, by keys and app, kept at most this many. */
const DISMISSED_KEPT = 32

export interface AppshotShortcutHolderOptions {
  /** Told whenever what Settings and Diagnostics show of the shortcut changes. */
  onWatch?: (watch: AppshotShortcutWatch) => void
  /** Told when another app came to the front right after a press, unless the person dismissed that hint for those keys and that app. */
  onHint?: (hint: { text: string; dismiss: () => void }) => void
  /** A file in the client's own data where dismissed hints are kept. */
  store?: string
  /** The preferences file whose changes are a reason to check: System Settings' shortcuts, or a test's own domain. */
  systemShortcuts?: string
}

/** System Settings' shortcuts file, watched: how, and a re-watch waiting after cfprefsd replaced it. */
interface PreferencesWatch {
  watcher: FSWatcher | null
  mode: AppshotShortcutWatch["watching"]["preferences"]
  rearm?: ReturnType<typeof setTimeout>
}

/** The keys as a hint names them. */
function keysOf(shortcut: AppshotShortcut): string {
  return shortcut.kind === "keys" ? chordGlyphs(shortcut.chord) : `both ${MODIFIER_NAMES[shortcut.modifier]} keys`
}

export class AppshotShortcutHolder {
  private current: AppshotShortcut | null = null
  private state: AppshotShortcutState = { state: "off" }
  private accelerator: string | null = null
  private poller: ChildProcess | null = null
  private last = 0
  /** A `set` still starting: every window asks on load, and they ask for the same keys. */
  private pending: { shortcut: AppshotShortcut | null; state: Promise<AppshotShortcutState> } | null = null
  /** Each `set` and each later check after the one before: a chord's checks take a moment, and two must not interleave. */
  private queue: Promise<void> = Promise.resolve()
  private readonly onTrigger: (front: number | null) => void
  private readonly options: AppshotShortcutHolderOptions
  private readonly schedule: CheckSchedule
  private checks: AppshotShortcutCheck[] = []
  private press: AppshotShortcutWatch["press"] = null
  private evidence: AppshotPressEvidence | null = null
  private activations: Activation[] = []
  private front: number | null = null
  private subscription: number | null = null
  private concluding: ReturnType<typeof setTimeout> | undefined
  private preferences: PreferencesWatch = { watcher: null, mode: "off" }
  private system = false
  private announcing = false
  private dismissed: Set<string> | null = null

  constructor(onTrigger: (front: number | null) => void, options: AppshotShortcutHolderOptions = {}) {
    this.onTrigger = onTrigger
    this.options = options
    this.schedule = new CheckSchedule(
      {
        now: () => Date.now(),
        after: (ms, run) => {
          const timer = setTimeout(run, ms)
          timer.unref()
          return () => clearTimeout(timer)
        },
      },
      (reason) => this.recheck(reason),
      () => powerMonitor.getSystemIdleTime(),
    )
  }

  private fire = () => {
    const now = Date.now()
    if (now - this.last < REPEAT_MS) return
    this.last = now
    this.schedule.pressed(now)
    // Read before anything reacts to the press: an app that comes to the
    // front because of these keys is not the window the person was in.
    const front = this.front
    this.watchPress(now)
    this.onTrigger(front)
  }

  private release(): void {
    if (this.accelerator) globalShortcut.unregister(this.accelerator)
    this.accelerator = null
    const poller = this.poller
    this.poller = null
    poller?.kill()
  }

  /** Hold `shortcut` (or nothing); asking again for what is held, or being taken, answers with that. */
  set(shortcut: AppshotShortcut | null): Promise<AppshotShortcutState> {
    if (process.platform !== "darwin")
      return Promise.resolve({ state: "unavailable", reason: "The capture shortcut works on macOS for now." })
    if (this.pending && sameShortcut(shortcut, this.pending.shortcut)) return this.pending.state
    if (!this.pending && sameShortcut(shortcut, this.current) && (this.state.state === "on" || (!shortcut && this.state.state === "off"))) {
      // A window asking again (Settings opening, a window loading) is a reason to look again, unless a check just ran.
      this.schedule.request("asked")
      this.announce()
      return Promise.resolve(this.state)
    }
    const state = this.queue.then(() => this.take(shortcut)).finally(() => {
      if (this.pending?.state === state) this.pending = null
    })
    this.queue = state.then(
      () => undefined,
      () => undefined,
    )
    this.pending = { shortcut, state }
    return state
  }

  private async take(shortcut: AppshotShortcut | null): Promise<AppshotShortcutState> {
    this.release()
    if (!sameShortcut(shortcut, this.current)) {
      // What a press said was about the keys it pressed.
      this.evidence = null
      this.press = null
    }
    this.current = shortcut
    if (!shortcut) {
      this.state = { state: "off" }
      this.arm()
      this.announce()
      return this.state
    }
    this.state = shortcut.kind === "keys" ? await this.holdChord(shortcut.chord) : await this.holdPair(shortcut.modifier)
    if (this.state.state === "on") this.state = { state: "on", shortcut }
    const clash = this.state.state === "refused" ? this.state.clash?.by : undefined
    hostLog("desktop", "appshot shortcut", { state: this.state.state, kind: shortcut.kind, clash })
    this.arm()
    this.announce()
    return this.state
  }

  private async holdChord(chord: string): Promise<AppshotShortcutState> {
    const accelerator = acceleratorOf(chord)
    if (!accelerator) return { state: "refused", reason: "Mako can't listen for that key everywhere. Choose a letter, number or function key." }
    // No guard: Mako holds nothing now, and a person recording keys is pressing these.
    const started = Date.now()
    const check = await checkChord(chord)
    const clash = "clash" in check ? check.clash : null
    this.record({ at: started, reason: "set", result: clash ? "clash" : "failed" in check && check.failed ? "failed" : "clear", ...(clash && { clash }), ms: Date.now() - started })
    this.schedule.checked()
    if (clash) return { state: "refused", reason: clashSentence(clash), clash }
    return this.register(chord, accelerator)
  }

  private register(chord: string, accelerator: string): AppshotShortcutState {
    // Says no only when this process already holds the keys; another app holding them still says yes.
    if (!globalShortcut.register(accelerator, this.fire))
      return { state: "refused", reason: "Mako couldn't hold these keys. Choose another combination." }
    this.accelerator = accelerator
    return { state: "on", shortcut: { kind: "keys", chord } }
  }

  /* Checked again later ------------------------------------------------------------- */

  /**
   * The chord a later check is about: held, or refused because macOS or
   * another app holds it (which may change). A pair has nothing to probe,
   * and keys refused by the rules stay refused.
   */
  private wantedChord(): string | null {
    if (this.current?.kind !== "keys") return null
    if (this.state.state === "on") return this.current.chord
    const by = this.state.state === "refused" ? this.state.clash?.by : undefined
    return by === "macos" || by === "held" ? this.current.chord : null
  }

  /** A later check, in the queue `set` uses, so it never interleaves with one. */
  private recheck(reason: AppshotCheckReason): Promise<CheckOutcome> {
    const outcome = this.queue.then(() => this.checkAgain(reason))
    this.queue = outcome.then(
      () => undefined,
      () => undefined,
    )
    return outcome
  }

  private async checkAgain(reason: AppshotCheckReason): Promise<CheckOutcome> {
    const chord = this.wantedChord()
    if (!chord) return "done"
    const held = this.state.state === "on"
    const started = Date.now()
    // Mako's own registration stays: the probe's sits over it for a moment, guarded.
    const check = await checkChord(chord, held)
    const ms = Date.now() - started
    if ("busy" in check) {
      this.record({ at: started, reason, result: "busy", ms })
      this.announce()
      return "busy"
    }
    const clash = check.clash
    this.record({ at: started, reason, result: clash ? "clash" : check.failed ? "failed" : "clear", ...(clash && { clash }), ms })
    const accelerator = acceleratorOf(chord)
    if (held && clash) {
      this.release()
      this.state = { state: "refused", reason: laterClashSentence(clash, chordGlyphs(chord)), clash, later: true }
      hostLog("desktop", "appshot shortcut taken since it was set", { reason, clash: clash.by })
      this.arm()
    } else if (!held && !clash && !check.failed && accelerator) {
      this.state = this.register(chord, accelerator)
      if (this.state.state === "on") hostLog("desktop", "appshot shortcut free again", { reason })
      this.arm()
    }
    this.announce()
    return "done"
  }

  /** A check's result, newest first; the log says only what changed. */
  private record(check: AppshotShortcutCheck): void {
    const previous = this.checks[0]
    this.checks = [check, ...this.checks].slice(0, WATCH_CHECKS)
    if (check.result === "busy") return
    if (!previous || previous.result !== check.result || previous.clash?.by !== check.clash?.by)
      hostLog("desktop", "appshot shortcut check", { reason: check.reason, result: check.result, clash: check.clash?.by, ms: check.ms })
  }

  /** Watch what a wanted chord can be taken by, and apps coming to the front while keys are held; nothing otherwise. */
  private arm(): void {
    const chord = this.wantedChord() !== null
    if (chord) {
      this.schedule.start()
      this.watchPreferences()
      this.watchSystem(true)
    } else {
      this.schedule.stop()
      this.unwatchPreferences()
      this.watchSystem(false)
    }
    this.watchActivations(this.state.state === "on")
  }

  private readonly woke = () => this.schedule.request("wake")
  private readonly unlocked = () => this.schedule.request("unlock")
  private readonly activated = () => this.schedule.request("active")

  private watchSystem(on: boolean): void {
    if (on === this.system) return
    this.system = on
    if (on) {
      powerMonitor.on("resume", this.woke)
      powerMonitor.on("unlock-screen", this.unlocked)
      app.on("did-become-active", this.activated)
    } else {
      powerMonitor.removeListener("resume", this.woke)
      powerMonitor.removeListener("unlock-screen", this.unlocked)
      app.removeListener("did-become-active", this.activated)
    }
  }

  /**
   * System Settings' shortcuts file, watched for a change. cfprefsd writes
   * it by replacing it, which ends a watch on the file, so each change
   * watches the new one. Until it exists (a Mac whose shortcuts were never
   * changed) its folder is watched for it instead.
   */
  private watchPreferences(): void {
    if (this.preferences.watcher) return
    const path = this.options.systemShortcuts ?? SYSTEM_SHORTCUTS
    const changed = () => {
      this.schedule.request("preferences")
      this.rewatchPreferences()
    }
    try {
      const file = existsSync(path)
      const watcher = file
        ? watch(path, { persistent: false }, (type) => {
            this.schedule.request("preferences")
            if (type === "rename") this.rewatchPreferences()
          })
        : watch(dirname(path), { persistent: false }, (_type, name) => {
            if (name === basename(path)) changed()
          })
      watcher.on("error", () => this.rewatchPreferences())
      this.preferences = { watcher, mode: file ? "file" : "folder" }
    } catch (error) {
      this.preferences = { watcher: null, mode: "off" }
      hostLog("desktop", "appshot shortcut: System Settings' shortcuts unwatched", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private rewatchPreferences(): void {
    clearTimeout(this.preferences.rearm)
    this.preferences.watcher?.close()
    this.preferences.watcher = null
    const rearm = setTimeout(() => {
      if (this.wantedChord() !== null) this.watchPreferences()
    }, 100)
    rearm.unref()
    this.preferences.rearm = rearm
  }

  private unwatchPreferences(): void {
    clearTimeout(this.preferences.rearm)
    this.preferences.watcher?.close()
    this.preferences = { watcher: null, mode: "off" }
  }

  /* What a press says about another app ---------------------------------------------- */

  /** NSWorkspace's word when an app comes to the front, heard in this process: nothing runs for it in between. */
  private watchActivations(on: boolean): void {
    if (on === (this.subscription !== null)) return
    if (!on) {
      if (this.subscription !== null) systemPreferences.unsubscribeWorkspaceNotification(this.subscription)
      this.subscription = null
      this.activations = []
      this.front = null
      clearTimeout(this.concluding)
      return
    }
    this.subscription = systemPreferences.subscribeWorkspaceNotification("NSWorkspaceDidActivateApplicationNotification", (_event, info) => {
      const described = z.string().safeParse(info["NSWorkspaceApplicationKey"])
      const running = described.success ? runningApplication(described.data) : null
      if (!running) return
      this.front = running.pid
      this.activations = [...this.activations, { at: Date.now(), ...running }].slice(-ACTIVATIONS_KEPT)
    })
    void frontPid().then((pid) => {
      if (this.subscription !== null && this.front === null) this.front = pid
    })
  }

  /** A press: what came to the front in the next REACT_MS is read once they've passed. */
  private watchPress(at: number): void {
    const shortcut = this.current
    if (this.subscription === null || !shortcut) return
    const press = { at, frontPid: this.front, shortcut }
    clearTimeout(this.concluding)
    this.concluding = setTimeout(() => void this.conclude(press), REACT_MS + 20)
    this.concluding.unref()
  }

  private async conclude(press: { at: number; frontPid: number | null; shortcut: AppshotShortcut }): Promise<void> {
    const reacted = reactingActivation(press, this.activations, new Set([process.pid]))
    let found: AppshotPressEvidence | null = null
    if (reacted) {
      const info = await appOf(reacted.pid)
      if (!systemApp(info.bundlePath))
        found = {
          app: info.name ?? reacted.bundleId ?? "Another app",
          bundleId: reacted.bundleId ?? info.bundleId,
          pid: reacted.pid,
          afterMs: reacted.at - press.at,
          shortcut: press.shortcut,
        }
    }
    // The keys changed meanwhile: this press says nothing about the new ones.
    if (!sameShortcut(press.shortcut, this.current)) return
    this.press = { at: press.at, evidence: found }
    this.evidence = keptEvidence(this.evidence, found, press.frontPid)
    if (found) {
      hostLog("desktop", "appshot shortcut: another app came to the front after a press", { app: found.bundleId ?? found.app, afterMs: found.afterMs })
      this.hint(found)
    }
    this.announce()
  }

  private hint(evidence: AppshotPressEvidence): void {
    const key = `${JSON.stringify(evidence.shortcut)}|${evidence.bundleId ?? evidence.app}`
    if (!this.options.onHint || this.dismissedHints().has(key)) return
    this.options.onHint({ text: evidenceHint(evidence, keysOf(evidence.shortcut)), dismiss: () => this.dismiss(key) })
  }

  private dismissedHints(): Set<string> {
    if (this.dismissed) return this.dismissed
    this.dismissed = new Set()
    try {
      if (this.options.store) {
        const kept = z.object({ dismissedHints: z.array(z.string()) }).safeParse(JSON.parse(readFileSync(this.options.store, "utf8")))
        if (kept.success) this.dismissed = new Set(kept.data.dismissedHints)
      }
    } catch {
      // Nothing dismissed yet.
    }
    return this.dismissed
  }

  private dismiss(key: string): void {
    const dismissed = [...this.dismissedHints(), key].slice(-DISMISSED_KEPT)
    this.dismissed = new Set(dismissed)
    if (!this.options.store) return
    try {
      writeFileSync(this.options.store, `${JSON.stringify({ dismissedHints: dismissed })}\n`)
    } catch (error) {
      hostLog("desktop", "appshot shortcut: hint dismissal unsaved", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** What Settings and Diagnostics show, once per turn of the event loop however many things changed. */
  private announce(): void {
    if (!this.options.onWatch || this.announcing) return
    this.announcing = true
    queueMicrotask(() => {
      this.announcing = false
      this.options.onWatch?.(this.watch())
    })
  }

  watch(): AppshotShortcutWatch {
    return {
      state: this.state,
      checks: this.checks,
      next: this.schedule.next(),
      watching: { preferences: this.preferences.mode, activations: this.subscription !== null },
      press: this.press,
      evidence: this.evidence,
    }
  }

  private holdPair(modifier: AppshotModifier): Promise<AppshotShortcutState> {
    const [left, right] = MODIFIER_MASKS[modifier]
    const poller = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", POLLER, String(left), String(right)], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    this.poller = poller
    const refused = { state: "refused", reason: `Mako couldn't listen for both ${MODIFIER_NAMES[modifier]} keys. Choose a key combination instead.` } as const
    return new Promise((resolve) => {
      let ready = false
      let buffered = ""
      const timer = setTimeout(() => {
        if (ready) return
        poller.kill()
        resolve(refused)
      }, READY_MS)
      poller.stderr?.setEncoding("utf8")
      poller.stderr?.on("data", (chunk: string) => {
        buffered += chunk
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines.map((entry) => entry.trim())) {
          if (line === "ready" && !ready) {
            ready = true
            clearTimeout(timer)
            resolve({ state: "on", shortcut: { kind: "modifiers", modifier } })
          } else if (line === "trigger" && ready && this.poller === poller) this.fire()
        }
        // A helper that prints anything else at length is not ours to buffer.
        if (buffered.length > 4096) buffered = ""
      })
      poller.once("error", () => {
        clearTimeout(timer)
        if (!ready) resolve(refused)
      })
      poller.once("exit", (code) => {
        clearTimeout(timer)
        if (!ready) resolve(refused)
        else if (this.poller === poller) {
          // The helper ended while it was held: say so to whoever asks next, and
          // let the next `set` start it again.
          this.poller = null
          this.state = { ...refused, reason: `The helper listening for both ${MODIFIER_NAMES[modifier]} keys stopped (exit ${code}). Turn the shortcut off and on again.` }
          this.current = null
          hostLog("desktop", "appshot shortcut helper stopped", { code })
          this.arm()
          this.announce()
        }
      })
    })
  }

  dispose(): void {
    this.release()
    this.current = null
    this.state = { state: "off" }
    this.arm()
  }
}
