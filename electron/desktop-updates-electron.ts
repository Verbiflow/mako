import type { UpdateState } from "./contracts/automations-usage-updates.js"
import { record } from "./crash.js"

type Updater = typeof import("electron-updater").autoUpdater
type ReleaseNotes = string | Array<{ note: string | null }> | null | undefined

interface UpdaterModule {
  autoUpdater?: Updater
  default?: { autoUpdater?: Updater }
}

/** A check at launch, then every six hours. More often than that is polling GitHub for something that changes a few times a week. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const INSTALL_AFTER_ANSWER_MS = 250

/**
 * The desktop app's updater. Squirrel replaces the bundle when the app that
 * asked quits, so it lives in the desktop, never in the host, which runs as
 * Node from inside that bundle. The host shows the state to every window and
 * asks for the install once it has stopped its work (`updates.ts`).
 *
 * Two rules shape this, and both are about not interrupting a running agent:
 *
 *   * **Never restart on its own.** A turn can be minutes long and involve real
 *     edits to real files. Downloading is automatic; installing is a decision,
 *     and the decision is the person's.
 *   * **Say nothing when there is nothing to say.** No "you are up to date"
 *     toast on every launch. The state is there on request.
 */
export interface DesktopUpdates {
  state(): UpdateState
  check(): Promise<UpdateState>
  /** A downloaded update is waiting to be installed. */
  ready(): boolean
  /** Quit into the installer and come back on the new version; called only once the host has stopped its work. */
  install(): void
  dispose(): void
}

export interface DesktopUpdatesInput {
  version: string
  /**
   * A signed, packaged app. Squirrel can't tell a development or unsigned
   * build's update came from the same publisher, so those say "unsupported".
   */
  supported: boolean
  /** Before the app quits into the installer, so its own quit isn't held for a window. */
  quitting(): void
  changed(state: UpdateState): void
}

export function desktopUpdates({ version, supported, quitting, changed }: DesktopUpdatesInput): DesktopUpdates {
  let state: UpdateState = { status: supported ? "idle" : "unsupported", version }
  let updater: Promise<Updater | null> | undefined
  const publish = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch }
    changed(state)
  }
  const load = () => updater ??= import("electron-updater").then((module: UpdaterModule) => {
    // The package is CommonJS; Node may find `autoUpdater` only on its default export.
    const auto = module.autoUpdater ?? module.default?.autoUpdater
    if (!auto) throw new Error("electron-updater exported no autoUpdater")
    auto.autoDownload = true
    // The one thing that must never happen without being asked.
    auto.autoInstallOnAppQuit = false
    auto.on("checking-for-update", () => publish({ status: "checking", error: undefined }))
    auto.on("update-not-available", () => publish({ status: "current", error: undefined }))
    auto.on("update-available", (info) => publish({ status: "downloading", available: info.version, progress: 0, error: undefined }))
    auto.on("download-progress", (progress) => publish({ status: "downloading", progress: Math.round(progress.percent) }))
    auto.on("update-downloaded", (info) => publish({ status: "ready", available: info.version, progress: 100, notes: notesFrom(info.releaseNotes) }))
    // An update that can't be fetched isn't a crash and mustn't read like one: this version works.
    auto.on("error", (error) => publish({ status: "error", error: error.message }))
    return auto
  }, (error: Error) => {
    record("main-uncaught", error, "electron-updater")
    return null
  })
  const check = async (): Promise<UpdateState> => {
    if (!supported || state.status === "ready" || state.status === "checking" || state.status === "downloading") return state
    const auto = await load()
    if (!auto) {
      publish({ status: "error", error: "Mako's updater couldn't start. This version keeps working." })
      return state
    }
    await auto.checkForUpdates().catch((error: Error) => publish({ status: "error", error: error.message }))
    return state
  }
  const timer = supported ? setInterval(() => void check(), CHECK_EVERY_MS) : undefined
  timer?.unref()
  if (supported) void check()
  return {
    state: () => state,
    check,
    ready: () => state.status === "ready",
    install() {
      if (state.status !== "ready") throw new Error("The downloaded update is no longer available.")
      // A moment for the answer to reach the host before this process quits.
      setTimeout(() => void load().then((auto) => {
        if (!auto) return
        quitting()
        // No installer window, and the app comes back rather than leaving the person at a closed window.
        auto.quitAndInstall(true, true)
      }), INSTALL_AFTER_ANSWER_MS)
    },
    dispose: () => clearInterval(timer),
  }
}

function notesFrom(notes: ReleaseNotes): string | undefined {
  if (!notes) return undefined
  const text = Array.isArray(notes) ? notes.map((entry) => entry.note ?? "").join("\n") : notes
  return plainText(text).trim().slice(0, 4000) || undefined
}

/** Release notes arrive as HTML and are shown as text, so no tag survives, nested or unclosed ones included. */
function plainText(html: string): string {
  let text = html
  for (let previous = ""; previous !== text;) {
    previous = text
    text = text.replace(/<[^<>]*>/g, "")
  }
  return text.replace(/[<>]/g, "")
}
