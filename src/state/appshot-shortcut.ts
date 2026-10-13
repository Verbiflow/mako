import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import type { AttachmentInput } from "@/lib/attachments"
import type { AppshotFeedback, AppshotShortcutState, AppshotShortcutWatch } from "@mako/host/contracts/appshot-shortcut"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { MakoComputerPermissions } from "@mako/host/contracts/mcp-skills-integrations"
import { appshotAttachment, appshots } from "@/state/appshots"
import { playFeedback } from "@/state/feedback"
import { prefsStore } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import { currentOnScreen } from "@/state/thread-sessions"

/**
 * The Appshot shortcut, on the desk's side.
 *
 * The desk owns the choice (Settings › Appshots, kept in its
 * preferences) and asks its client to hold the keys. When they are
 * pressed in another app, the client tells the window the person last
 * used, and this module takes it from there: it finds the window they were
 * in (never Mako's own), shows that something is happening before the
 * capture finishes, captures through the host's driver, drops the capture
 * into the composer on screen and says where it went.
 *
 * Where that is said depends on where the person is. With Mako behind the
 * other app, the client flashes the captured window and shows a card in the
 * corner of its display (`mako:appshot-feedback`), and nothing is brought
 * forward unless they asked for that in Settings. With Mako in front (they
 * pressed the shortcut here, to capture the window behind it), the capture
 * flies into the composer (`AppshotFlight`).
 *
 * Whether the keys reach Mako is checked by pressing them, because that is
 * the one thing macOS can't be asked: another app's hot key is told of the
 * press too, and keys another app holds never reach Mako's window. So while
 * Settings records keys, Mako lets go of its own (the recorder hears them,
 * and a press that doesn't arrive says something else has them), asks the
 * client to hold the keys just recorded, and a second press is the check;
 * after keys change, Settings asks for one press and says when it arrived.
 *
 * Keys can be taken after that, which macOS doesn't announce. The client
 * checks them again when something could have taken them and watches what
 * follows each press; what it knows comes to every window as `watch`
 * (`appshot-shortcut-watch`), for Settings' one line and Diagnostics.
 */

export type Flight =
  | { id: string; phase: "capturing"; app: string; icon?: string }
  | { id: string; phase: "landing"; app: string; image: string; icon?: string }

/** A press Settings asked for, to show the keys reach Mako; `at` is when it started or arrived. */
export interface AppshotCheck {
  phase: "waiting" | "reached"
  at: number
}

interface AppshotShortcutStore {
  /** What the client said when it was last asked to hold the keys; null before it answered. */
  status: AppshotShortcutState | null
  /** A capture running now. */
  flight: Flight | null
  /** Why the last capture failed, for Settings to show beside its fix. */
  failure: string | null
  /** Mako's Screen Recording and Accessibility grants, as macOS reports them to the desktop app. */
  permissions: MakoComputerPermissions | null
  /** A grant is being asked for. */
  asking: boolean
  /** Settings is recording keys: Mako's own are let go, and a press is a check, never a capture. */
  recording: boolean
  check: AppshotCheck | null
  /** What the client knows of the shortcut since it was set: later checks, the last press and what followed it. */
  watch: AppshotShortcutWatch | null
}

export const appshotShortcutStore = createStore<AppshotShortcutStore>({
  status: null,
  flight: null,
  failure: null,
  permissions: null,
  asking: false,
  recording: false,
  check: null,
  watch: null,
})
export const useAppshotShortcut = createHook(appshotShortcutStore)

/** Tell this window's client which keys to hold, from the preferences. */
async function hold(): Promise<void> {
  const prefs = prefsStore.get()
  try {
    const status = await getMako().setAppshotShortcut(prefs.appshotShortcutOn ? prefs.appshotShortcut : null)
    appshotShortcutStore.set({ status })
    // Start the host's driver now, so the first press waits only for its capture.
    // Listing windows captures nothing.
    if (status.state === "on") void appshots.frontWindow([]).catch(() => undefined)
  } catch (error) {
    appshotShortcutStore.set({
      status: { state: "unavailable", reason: error instanceof Error ? error.message : "This Mako client can't hold a shortcut." },
    })
  }
}

/** The desk's own colours for the card the client draws, so it wears the theme in use. */
function themeColors(): AppshotFeedback["colors"] {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    surface: read("--popover"),
    text: read("--foreground"),
    muted: read("--muted-foreground"),
    border: read("--border"),
    font: getComputedStyle(document.body).fontFamily,
  }
}

/** A small JPEG of the capture for the card and the flight: the full picture never crosses to the client. */
async function thumbnailOf(file: File, width = 360): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, width / bitmap.width)
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => (reader.result === null || reader.result instanceof ArrayBuffer ? reject(new Error("unreadable")) : resolve(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error("unreadable"))
      reader.readAsDataURL(blob)
    })
  } catch {
    return undefined
  }
}

/** Hand the capture to the composer on screen; false when none took it (Settings covers the window, say). */
function attach(input: AttachmentInput): boolean {
  const event = new CustomEvent("mako:attach", {
    cancelable: true,
    detail: { files: [input], text: (references: string) => references },
  })
  return !window.dispatchEvent(event)
}

/** A sentence for a failed capture: what to do about missing grants, else what went wrong. */
async function failureMessage(reason: string): Promise<string> {
  const permissions = await getMako().computerPermissions().catch(() => null)
  if (permissions?.supported && permissions.screenRecording !== "granted")
    return "Mako needs Screen Recording to take Appshots. Allow it in Settings › Appshots."
  if (permissions?.supported && !permissions.accessibility)
    return "Mako needs Accessibility to read the window. Allow it in Settings › Appshots."
  return reason
}

let running = false

/** What a capture's card names before and after the capture: the app and its window. */
type Shown = Pick<AppshotFeedback, "app" | "title">

/** The shortcut was pressed: capture the window the person is in and put it in the draft on screen. */
export async function captureFromShortcut(exclude: number[], front?: number): Promise<void> {
  // A second press while one capture runs is the same intent.
  if (running) return
  running = true
  const id = crypto.randomUUID()
  // Pressed in Mako: the person is looking at the desk, so the desk shows it.
  const here = document.hasFocus()
  const colors = themeColors()
  const destination = currentOnScreen().title
  let shown: Shown = { app: "the window", title: "" }
  const feedback = (update: Omit<AppshotFeedback, "id" | "app" | "title" | "colors">) => {
    void getMako().appshotFeedback({ id, app: shown.app, title: shown.title, colors, ...update }).catch(() => undefined)
  }
  try {
    const target = await appshots.frontWindow(exclude, front)
    shown = { app: target.app, title: target.title }
    if (here) appshotShortcutStore.set({ flight: { id, phase: "capturing", app: target.app } })
    else feedback({ phase: "capturing", ...(target.bounds && { bounds: target.bounds }) })
    const shot = await appshots.read({ pid: target.pid, windowId: target.windowId })
    const input = appshotAttachment(shot)
    if (input instanceof File || !attach(input)) throw new Error("Open a conversation in Mako, then press the shortcut again.")
    const icon = input.window?.icon
    const thumbnail = await thumbnailOf(input.file)
    appshotShortcutStore.set({ failure: null })
    playFeedback("copy")
    if (here || prefsStore.get().appshotThenMako) {
      if (!here) {
        feedback({ phase: "added", ...(thumbnail && { thumbnail }), ...(icon && { icon }), ...(destination && { destination }) })
        await getMako().surfaceWindow().catch(() => undefined)
      }
      if (thumbnail) appshotShortcutStore.set({ flight: { id, phase: "landing", app: shot.window.app, image: thumbnail, ...(icon && { icon }) } })
      else appshotShortcutStore.set({ flight: null })
    } else {
      feedback({ phase: "added", ...(thumbnail && { thumbnail }), ...(icon && { icon }), ...(destination && { destination }) })
    }
  } catch (error) {
    const message = await failureMessage(error instanceof Error ? error.message : "The window couldn't be captured.")
    appshotShortcutStore.set({ failure: message, flight: null })
    if (here) toast.error(message)
    else feedback({ phase: "failed", message })
  } finally {
    running = false
  }
}

/**
 * The client said the keys were pressed. While Settings waits for a press
 * and the person is looking at it, the press is the check; anywhere else it
 * is an Appshot, and still answers a check.
 */
export function shortcutPressed(exclude: number[], front?: number): void {
  const { check, recording } = appshotShortcutStore.get()
  const checking = recording || check?.phase === "waiting"
  if (checking) appshotShortcutStore.set({ check: { phase: "reached", at: Date.now() } })
  if (recording || (checking && document.hasFocus())) return
  void captureFromShortcut(exclude, front)
}

/** Whether a press reached Mako since `time`, for the recorder to tell a check from keys that never arrived. */
export function pressedSince(time: number): boolean {
  const { check } = appshotShortcutStore.get()
  return check?.phase === "reached" && check.at >= time
}

/** Settings changed the keys or turned them on: ask for one press. */
export function startAppshotCheck(): void {
  appshotShortcutStore.set({ check: { phase: "waiting", at: Date.now() } })
}

export function endAppshotCheck(): void {
  appshotShortcutStore.set({ check: null })
}

/** Recording starts: let go of Mako's own keys, which would otherwise take the press before the recorder hears it. */
export async function beginAppshotRecording(): Promise<void> {
  appshotShortcutStore.set({ recording: true, check: null })
  if (hasBridge()) await getMako().setAppshotShortcut(null).catch(() => undefined)
}

/**
 * Ask the client whether it can hold keys just recorded, and hold them
 * while recording goes on, so pressing them again checks they reach Mako.
 * Null where no client holds keys (a browser tab).
 */
export async function tryAppshotChord(chord: string): Promise<AppshotShortcutState | null> {
  if (!hasBridge()) return null
  appshotShortcutStore.set({ check: null })
  try {
    return await getMako().setAppshotShortcut({ kind: "keys", chord })
  } catch {
    return null
  }
}

/** Recording ends, saved or not: hold what the preferences name again. */
export function endAppshotRecording(): Promise<void> {
  appshotShortcutStore.set({ recording: false })
  return hold()
}

/** The flight landed or was skipped; the overlay goes. */
export function endFlight(id: string): void {
  if (appshotShortcutStore.get().flight?.id === id) appshotShortcutStore.set({ flight: null })
}

/**
 * Hold the keys the preferences name, again whenever they change, and act
 * on the client's word that they were pressed. Bound once per window.
 */
export function bindAppshotShortcut(): () => void {
  if (!hasBridge()) return () => {}
  let held = ""
  const sync = () => {
    const prefs = prefsStore.get()
    const wanted = JSON.stringify(prefs.appshotShortcutOn ? prefs.appshotShortcut : null)
    if (wanted === held) return
    held = wanted
    void hold()
  }
  sync()
  const off = prefsStore.subscribe(sync)
  const stop = getMako().onEvent((event: HostEvent) => {
    if (event.type === "appshot-shortcut") shortcutPressed(event.exclude, event.front)
    // A later check can take the keys or give them back; while Settings records, its own answers are the word.
    if (event.type === "appshot-shortcut-watch")
      appshotShortcutStore.set(appshotShortcutStore.get().recording ? { watch: event.watch } : { watch: event.watch, status: event.watch.state })
  })
  return () => {
    off()
    stop()
  }
}

/** Read Mako's grants, for Settings. */
export async function readAppshotPermissions(): Promise<void> {
  if (!hasBridge()) return
  const permissions = await getMako().computerPermissions().catch(() => null)
  appshotShortcutStore.set({ permissions })
}

/**
 * Ask macOS for the grants a capture needs, through the desktop app, which
 * explains each one in front of Mako's window and opens the right pane of
 * System Settings (`computer-permissions.ts`, as Settings › MCP's Allow does).
 */
export async function requestAppshotPermissions(): Promise<void> {
  if (!hasBridge() || appshotShortcutStore.get().asking) return
  appshotShortcutStore.set({ asking: true })
  try {
    appshotShortcutStore.set({ permissions: await getMako().requestComputerPermissions() })
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "macOS didn't take the request. Open System Settings › Privacy & Security.")
  } finally {
    appshotShortcutStore.set({ asking: false })
  }
}

/** Ask the client again (after a refusal the person fixed elsewhere, say). */
export function retryAppshotShortcut(): Promise<void> {
  return hold()
}

/**
 * Settings opened: ask the client for the keys again, which it takes as a
 * reason to check them again unless it just did. The answer, and anything
 * the check finds, comes back as the client's word.
 */
export async function recheckAppshotShortcut(): Promise<void> {
  const prefs = prefsStore.get()
  if (!hasBridge() || !prefs.appshotShortcutOn) return
  const status = await getMako().setAppshotShortcut(prefs.appshotShortcut).catch(() => null)
  if (status && !appshotShortcutStore.get().recording) appshotShortcutStore.set({ status })
}
