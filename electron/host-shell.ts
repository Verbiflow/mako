import type { z } from "zod"
import type { NativeCrashes } from "./crash.js"
import type { DeskPage } from "./desk-browser.js"
import type { DesktopNotifier } from "./desktop-notifications.js"
import type { HostEnvironment } from "./host-environment.js"
import { nodeHostExit, type HostLifecycle, type HostLifecycleOptions } from "./host-lifecycle.js"
import type { HostEvent, TerminalEvent } from "./shared.js"
import type { PrivacyReadings } from "./computer-permissions.js"
import type { WindowCapturer } from "./appshots.js"
import type { UpdaterModule } from "./updates.js"

/** What a shell needs from the host it carries. */
export interface ShellHost {
  environment: HostEnvironment
  development: boolean
  /** A host that outlives its clients (`MAKO_HOST_ONLY`). */
  persistent: boolean
  /** The renderer bundle served on `mako-app://desk/` when not on Vite. */
  rendererBundle: string
  preload: string
  devServerUrl(): string | null
  isDeskUrl(url: string): boolean
  openLink(url: string): void
  emit(event: HostEvent): void
  /** A window closed; its terminals and workspace go with it. */
  release(client: string): void
  running(): boolean
  /** Desktop and web clients on the socket. */
  socketClients(): number
}

/**
 * The process the host runs in. Electron's shell draws the host's own windows
 * (the standalone window, its previews, the hidden desk windows agents drive),
 * serves its file schemes and follows Electron's app events. Node's shell has
 * none of that: every window belongs to a client on the socket. No other host
 * module may import Electron (`scripts/check-host-electron.mjs`).
 */
export interface HostShell {
  readonly runtime: "electron" | "node"
  readonly nativeCrashes?: NativeCrashes
  /** Electron's own answers that disagree with the host environment's, logged at start. */
  readonly disagreements: ReadonlyArray<readonly [name: string, values: readonly [ours: string | boolean, electron: string | boolean]]>
  readonly exit: HostLifecycleOptions["exit"]
  /** Electron's single-instance lock, which standalone mode alone keeps, to reopen its window on a second launch. */
  singleInstance(): boolean
  ready(): Promise<void>
  /** An event for this process's own windows, or the one window `client` names. */
  send(channel: "mako:event" | "mako:terminal-event", payload: HostEvent | TerminalEvent | z.infer<ReturnType<typeof z.json>>, client?: string): void
  /** Clients for this process's own windows, desk windows included. */
  clients(): string[]
  /** A window a person opened, not a hidden desk window, is open. */
  windowOpen(): boolean
  windowVisible(): boolean
  hideWindows(): void
  /** Show this process's windows again; `create` draws the standalone window if it closed. */
  reopen(create: boolean): Promise<void>
  createWindow(): Promise<void>
  openPreviewWindow(): Promise<void>
  /** A hidden desk window for agents to drive; absent where the host draws no windows. */
  readonly deskPage?: (previewId: string) => Promise<DeskPage>
  readonly notifier: DesktopNotifier
  /** macOS's privacy settings, read in this process; absent where a desktop app must read them. */
  readonly privacy?: PrivacyReadings
  /** The system's window capturer in this process; absent where a desktop app must capture. */
  readonly capturer?: WindowCapturer
  /** `electron-updater`, which needs Electron's main process. */
  readonly updater?: () => Promise<UpdaterModule>
  /** The window a notification click surfaces, by its client id number. */
  notificationWindow(): number
  /** Bring this process forward for a macOS permission prompt. */
  focusForPermission(): void
  /** Once ready: the file schemes, the Dock, the about panel, and the windows' page transport. */
  start(files: (request: Request) => Promise<Response>): Promise<void>
  onActivate(listener: () => void): void
  onSystemShutdown(listener: () => void): void
  /** Electron's quit, which keeps the host in the background while `keepInBackground` holds. */
  followQuit(lifecycle: HostLifecycle, keepInBackground: () => boolean): void
}

const STANDALONE = "Mako's own window needs Electron; open the desktop app or a browser on this host's socket."

/** Notifications belong to the desktop app; a Node host has no banners of its own. */
const absentNotifier: DesktopNotifier = {
  notify: () => Promise.resolve({ delivered: false, reason: "unsupported" }),
  dismiss: () => {},
  setBadgeCount: () => {},
  permission: () => Promise.resolve("unsupported"),
  dispose: () => {},
}

/** The host under plain Node, or Electron's Helper in Node mode: windows belong to clients alone. */
export function nodeShell(): HostShell {
  return {
    runtime: "node",
    disagreements: [],
    exit: nodeHostExit(),
    singleInstance: () => true,
    ready: () => Promise.resolve(),
    send: () => {},
    clients: () => [],
    windowOpen: () => false,
    windowVisible: () => false,
    hideWindows: () => {},
    reopen: () => Promise.resolve(),
    createWindow: () => Promise.reject(new Error(STANDALONE)),
    openPreviewWindow: () => Promise.reject(new Error(STANDALONE)),
    notifier: absentNotifier,
    notificationWindow: () => 0,
    focusForPermission: () => {},
    start: () => Promise.resolve(),
    onActivate: () => {},
    onSystemShutdown: () => {},
    followQuit: () => {},
  }
}
