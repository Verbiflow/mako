import { app } from "electron"
import { join } from "node:path"
import type { UpdateInstallation } from "./contracts/app-lifecycle.js"
import { buildMetadata } from "./build-identity.js"
import { LocalUpdates } from "./local-updates.js"
import { prepareLocalInstall } from "./local-update-install.js"
import type { HostEvent, UpdateState } from "./shared.js"
import { record } from "./crash.js"
import { packagedDistribution } from "./distribution.js"

/**
 * Updates.
 *
 * Two rules shape this, and both are about not interrupting a running agent:
 *
 *   * **Never restart on its own.** A turn can be minutes long and involve real
 *     edits to real files. An update that relaunches the app underneath that is
 *     not an improvement. Downloading is automatic; installing is a decision,
 *     and the decision is the user's.
 *   * **Say nothing when there is nothing to say.** No "you are up to date"
 *     toast on every launch. The status is available on request; it does not
 *     announce itself unless there is genuinely a new version.
 *
 * `electron-updater` is loaded lazily so a dev run — where there is no update
 * feed and never will be — does not pay for it at boot.
 */

type Updater = typeof import("electron-updater").autoUpdater

type ReleaseNotes =
  | { kind: "text"; text: string }
  | { kind: "entries"; entries: Array<{ note: string | null }> }
  | { kind: "none" }

interface UpdaterModule {
  autoUpdater?: Updater
  default?: { autoUpdater?: Updater }
}

let updater: Updater | null = null
let state: UpdateState = { status: "idle", version: app.getVersion() }
let emit: (event: HostEvent) => void = () => {}
let local: LocalUpdates | null = null
const metadata = buildMetadata()

export function installationState(): UpdateInstallation {
  return { distribution: app.isPackaged ? packagedDistribution(app.getAppPath()) : "development", build: metadata.makoBuild ?? null, ...local?.snapshot() ?? { source: null, local: { kind: "idle" } } }
}

export async function selectUpdateSource(path: string): Promise<UpdateInstallation> {
  if (!local) throw new Error("Building updates is available in locally signed macOS installations.")
  await local.select(path)
  return installationState()
}

export function buildUpdate(): void {
  if (!local) throw new Error("Building updates is available in locally signed macOS installations.")
  local.start()
}

export function assertUpdateReady(): void {
  if (!local?.ready && state.status !== "ready") throw new Error("Prepare and verify an update before installing it.")
}

export function updateBuilding(): boolean { return local?.building ?? false }

export async function prepareUpdateInstall() {
  assertUpdateReady()
  if (local) return prepareLocalInstall(await local.prepared(), join(app.getPath("userData"), "updates/install-result.json"))
  const auto = await load()
  if (!auto || state.status !== "ready") throw new Error("The downloaded update is no longer available.")
  return { install: () => installNow(auto), cancel: () => {} }
}

function updatesSupported(): boolean {
  return (
    app.isPackaged && packagedDistribution(app.getAppPath()) === "signed"
  )
}

function publish(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  emit({ type: "update", update: state })
}

export function updateState(): UpdateState {
  return state
}

/**
 * Load the updater, once.
 *
 * Returns null in development and unsigned builds, where Squirrel cannot
 * authenticate an update as coming from the same publisher. The UI reads that
 * as "updates do not apply here".
 */
async function load(): Promise<Updater | null> {
  if (updater) return updater
  if (!updatesSupported()) return null
  try {
    const module: UpdaterModule = await import("electron-updater")
    // The package is CJS; the default export is what carries `autoUpdater`.
    const auto = module.autoUpdater ?? module.default?.autoUpdater
    if (!auto) return null

    auto.autoDownload = true
    // The one thing that must never happen without being asked.
    auto.autoInstallOnAppQuit = false

    auto.on("checking-for-update", () =>
      publish({ status: "checking", error: undefined })
    )
    auto.on("update-not-available", () =>
      publish({ status: "current", error: undefined })
    )
    auto.on("update-available", (info) =>
      publish({
        status: "downloading",
        available: info.version,
        progress: 0,
        error: undefined,
      })
    )
    auto.on("download-progress", (progress) =>
      publish({ status: "downloading", progress: Math.round(progress.percent) })
    )
    auto.on("update-downloaded", (info) =>
      publish({
        status: "ready",
        available: info.version,
        progress: 100,
        notes: notesFrom(parseReleaseNotes(info.releaseNotes)),
      })
    )
    auto.on("error", (error) => {
      // An update that cannot be fetched is not a crash and must not read like
      // one — the app works fine on the version it already has.
      publish({ status: "error", error: error.message })
    })

    updater = auto
    return auto
  } catch (error) {
    record("main-uncaught", error, "electron-updater")
    return null
  }
}

function parseReleaseNotes(
  notes: string | Array<{ note: string | null }> | null | undefined
): ReleaseNotes {
  if (isString(notes)) return { kind: "text", text: notes }
  if (Array.isArray(notes)) return { kind: "entries", entries: notes }
  return { kind: "none" }
}

function notesFrom(notes: ReleaseNotes): string | undefined {
  if (notes.kind === "none") return undefined
  const text =
    notes.kind === "text"
      ? notes.text
      : notes.entries.map((entry) => entry.note ?? "").join("\n")
  return text
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, 4000)
}

function isString(
  value: string | Array<{ note: string | null }> | null | undefined
): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function installUpdates(send: (event: HostEvent) => void) {
  emit = send
  if (app.isPackaged && process.platform === "darwin" && packagedDistribution(app.getAppPath()) === "local" && metadata.makoLocalSigningIdentity) {
    local = new LocalUpdates(join(app.getPath("userData"), "updates"), metadata.makoLocalSigningIdentity, () => emit({ type: "installation", installation: installationState() }), metadata.makoBuild ?? null)
    void local.load().then(() => emit({ type: "installation", installation: installationState() })).catch(() => emit({ type: "notice", level: "error", message: "The saved update state could not be read. Choose the source checkout again in Settings > Updates." }))
  }
  if (!updatesSupported()) {
    state = { status: "unsupported", version: app.getVersion() }
    return
  }
  // A check at launch, then every six hours. More often than that is polling
  // GitHub for something that changes a few times a week.
  void check()
  setInterval(() => void check(), 6 * 60 * 60 * 1000).unref?.()
}

export async function check(): Promise<UpdateState> {
  if (state.status === "ready" || state.status === "checking" || state.status === "downloading") return state
  const auto = await load()
  if (!auto) {
    publish({ status: updatesSupported() ? "current" : "unsupported" })
    return state
  }
  try {
    await auto.checkForUpdates()
  } catch (error) {
    publish({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return state
}

/** Relaunch into the downloaded version. Only ever called from a click. */
function installNow(auto: Updater) {
  if (state.status !== "ready") throw new Error("The downloaded update is no longer available.")
  // `isSilent: true, isForceRunAfter: true` — no installer UI, and the app
  // comes back rather than leaving the user staring at a closed window.
  auto.quitAndInstall(true, true)
}
