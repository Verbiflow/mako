import type { Git } from "@mako/git"
import { join } from "node:path"
import type { UpdateInstallation } from "../contracts/app-lifecycle.js"
import { LocalUpdates } from "./local-updates.js"
import { prepareLocalInstall } from "./local-update-install.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { UpdateState } from "../contracts/automations-usage-updates.js"
import { packagedDistribution } from "./distribution.js"
import type { HostEnvironment } from "../base/host-environment.js"
import { hostWarn } from "../base/host-log.js"
import { onMac } from "../base/platform.js"

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

const UNAVAILABLE = "Building updates is available in locally signed macOS installations."

export interface UpdatesOptions {
  environment: HostEnvironment
  git: Git
  emit(event: HostEvent): void
  desktop: DesktopUpdater
}

export class Updates {
  private readonly environment: HostEnvironment
  private readonly git: Git
  private readonly emit: (event: HostEvent) => void
  private readonly desktop: DesktopUpdater
  /** A locally signed install's builder, once `start` has made it. */
  private local: LocalUpdates | null = null

  constructor({ environment, git, emit, desktop }: UpdatesOptions) {
    this.environment = environment
    this.git = git
    this.emit = emit
    this.desktop = desktop
  }

  /** A locally signed install reads where its last build got to and is ready to build the next. */
  start(): void {
    const identity = this.environment.build.makoLocalSigningIdentity
    if (!this.environment.packaged || !onMac() || packagedDistribution(this.environment.appRoot) !== "local" || !identity) return
    const local = new LocalUpdates(this.git, join(this.environment.dataRoot, "updates"), identity, () => this.installationChanged(), this.environment.build.makoBuild ?? null)
    this.local = local
    void local.load().then(() => this.installationChanged()).catch(() => this.emit({ type: "notice", level: "error", message: "The saved update state could not be read. Choose the source checkout again in Settings > Updates." }))
  }

  installation(): UpdateInstallation {
    const distribution = this.environment.packaged ? packagedDistribution(this.environment.appRoot) : "development"
    return { distribution, build: this.environment.build.makoBuild ?? null, ...this.local?.snapshot() ?? { source: null, local: { kind: "idle" } } }
  }

  async selectSource(path: string): Promise<UpdateInstallation> {
    if (!this.local) throw new Error(UNAVAILABLE)
    await this.local.select(path)
    return this.installation()
  }

  build(): void {
    if (!this.local) throw new Error(UNAVAILABLE)
    this.local.start()
  }

  state(): UpdateState {
    return this.desktop.state() ?? { status: "unsupported", version: this.environment.version }
  }

  get building(): boolean {
    return this.local?.building ?? false
  }

  assertReady(): void {
    if (!this.local?.ready && this.state().status !== "ready") throw new Error("Prepare and verify an update before installing it.")
  }

  async prepareInstall() {
    this.assertReady()
    if (this.local) return prepareLocalInstall(await this.local.prepared(), join(this.environment.dataRoot, "updates/install-result.json"))
    if (this.state().status !== "ready") throw new Error("The downloaded update is no longer available.")
    const desktop = this.desktop
    return {
      install: () => {
        void desktop.install().catch((error: Error) => hostWarn("updates", "the desktop didn't confirm the install", { reason: error.message }))
      },
      cancel: () => {},
    }
  }

  /** The desktop's updater moved, or the desktop that had one left. */
  desktopChanged(): void {
    this.emit({ type: "update", update: this.state() })
  }

  /** Look for an update now, through the desktop; without one, updates don't apply here. */
  check(): Promise<UpdateState> {
    return this.desktop.state() ? this.desktop.check() : Promise.resolve(this.state())
  }

  private installationChanged(): void {
    this.emit({ type: "installation", installation: this.installation() })
  }
}
