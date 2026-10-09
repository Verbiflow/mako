import { join } from "node:path"
import type { UpdateInstallation } from "./contracts/app-lifecycle.js"
import { buildMetadata } from "./build-identity.js"
import { LocalUpdates } from "./local-updates.js"
import { prepareLocalInstall } from "./local-update-install.js"
import type { HostEvent, UpdateState } from "./shared.js"
import { packagedDistribution } from "./distribution.js"
import { hostEnvironment } from "./host-environment.js"
import { hostWarn } from "./host-log.js"
import { onMac } from "./platform.js"

/**
 * Updates, as the host shows them to every window and installs them once its
 * work has stopped.
 *
 *   * **A signed app updates itself through the desktop app**
 *     (`desktop-updates-electron.ts`). Squirrel replaces the bundle when the
 *     app that asked quits, and the host runs as Node from inside that bundle,
 *     so the updater is the desktop's. It tells the host where it is on
 *     `/desktop`; with no desktop open, updates read "unsupported".
 *   * **A locally signed install builds its update from a checkout** here
 *     (`local-updates.ts`), and an installer the host starts replaces the app
 *     once the host has left.
 */

/** The desktop's updater, as the host reaches it (`desktop-channel.ts`). */
export interface DesktopUpdater {
  /** Where it is; nothing while no desktop with an updater is attached. */
  state(): UpdateState | undefined
  check(): Promise<UpdateState>
  /** The desktop quits into the installer once it has answered. */
  install(): Promise<void>
}

let emit: (event: HostEvent) => void = () => {}
let desktop: DesktopUpdater | undefined
let local: LocalUpdates | null = null
const metadata = buildMetadata()

export function installationState(): UpdateInstallation {
  return { distribution: hostEnvironment().packaged ? packagedDistribution(hostEnvironment().appRoot) : "development", build: metadata.makoBuild ?? null, ...local?.snapshot() ?? { source: null, local: { kind: "idle" } } }
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

export function updateState(): UpdateState {
  return desktop?.state() ?? { status: "unsupported", version: hostEnvironment().version }
}

export function assertUpdateReady(): void {
  if (!local?.ready && updateState().status !== "ready") throw new Error("Prepare and verify an update before installing it.")
}

export function updateBuilding(): boolean { return local?.building ?? false }

export async function prepareUpdateInstall() {
  assertUpdateReady()
  if (local) return prepareLocalInstall(await local.prepared(), join(hostEnvironment().dataRoot, "updates/install-result.json"))
  const updater = desktop
  if (!updater || updateState().status !== "ready") throw new Error("The downloaded update is no longer available.")
  return {
    install: () => {
      void updater.install().catch((error: Error) => hostWarn("updates", "the desktop didn't confirm the install", { reason: error.message }))
    },
    cancel: () => {},
  }
}

/** The desktop's updater moved, or the desktop that had one left. */
export function desktopUpdateChanged(): void {
  emit({ type: "update", update: updateState() })
}

/** Look for an update now, through the desktop; without one, updates don't apply here. */
export function check(): Promise<UpdateState> {
  return desktop?.state() ? desktop.check() : Promise.resolve(updateState())
}

export function installUpdates(send: (event: HostEvent) => void, updater: DesktopUpdater) {
  emit = send
  desktop = updater
  if (hostEnvironment().packaged && onMac() && packagedDistribution(hostEnvironment().appRoot) === "local" && metadata.makoLocalSigningIdentity) {
    local = new LocalUpdates(join(hostEnvironment().dataRoot, "updates"), metadata.makoLocalSigningIdentity, () => emit({ type: "installation", installation: installationState() }), metadata.makoBuild ?? null)
    void local.load().then(() => emit({ type: "installation", installation: installationState() })).catch(() => emit({ type: "notice", level: "error", message: "The saved update state could not be read. Choose the source checkout again in Settings > Updates." }))
  }
}
