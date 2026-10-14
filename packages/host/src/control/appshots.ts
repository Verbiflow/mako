import {
  appshotWindows,
  captureAppshot,
  frontAppshotWindow,
  frontmostPid,
  type AppshotRead,
  type ComputerDriverClient,
} from "@mako/control-runtime/host"
import type { Appshot, AppshotTarget, AppshotWindow, ControlImage } from "@mako/control-runtime/contracts"
import { hostLog } from "../base/host-log.js"

export { frontmostPid }

/** A window as the system's capturer sees it. */
export interface CapturedWindow {
  windowId: number
  name: string
  thumbnail?: ControlImage
  icon?: ControlImage
}

/**
 * Electron's `desktopCapturer` (`window-capture-electron.ts`): in the desktop
 * app, which a host under Node asks, or in a host Electron runs.
 */
export interface WindowCapturer {
  /** Every window with a 320-wide JPEG thumbnail and its app's 24-point icon. */
  windows(): Promise<CapturedWindow[]>
  /** The capture source for the window's video, or null once it's gone. */
  source(windowId: number): Promise<string | null>
  /** One window's app icon, without drawing every window's thumbnail. */
  icon?(windowId: number): Promise<ControlImage | null>
}

/**
 * Where the person's Appshots reach the driver: a lease on the host's driver
 * broker (`DriverBroker`), the same owner every task's session goes through,
 * and its once-per-daemon warm-up.
 */
export interface AppshotDriver {
  connect(): Promise<ComputerDriverClient>
  warm(): Promise<void>
}

/**
 * The person's Appshots: the + menu's chooser and the shortcut. Taking one
 * is Mako control's (`captureAppshot` in `@mako/control-runtime`, the same
 * capture an agent's `window.appshot()` makes); the host's driver broker
 * gives them a lease of their own, since no agent's session is the person's,
 * and this adds what only the desktop can say: thumbnails, app icons and the
 * live source of a window's video. Nothing here focuses a window or sends
 * input.
 *
 * Listing windows warms the driver (`DriverBroker.warm`, once per daemon):
 * the chooser opening lists them, and turning the shortcut on asks for the
 * front window, so the first capture after the driver starts doesn't wait
 * for the driver's first picture.
 */
export class Appshots {
  private connection: Promise<ComputerDriverClient> | undefined
  private readonly driver: AppshotDriver
  private readonly capturer: () => WindowCapturer | undefined
  private readonly front: () => Promise<number | null>
  constructor(
    driver: AppshotDriver,
    capturer: () => WindowCapturer | undefined = () => undefined,
    front: () => Promise<number | null> = frontmostPid
  ) {
    this.driver = driver
    this.capturer = capturer
    this.front = front
  }

  private client(): Promise<ComputerDriverClient> {
    this.connection ??= (async () => {
      const client = await this.driver.connect()
      client.onClose(() => {
        this.connection = undefined
      })
      return client
    })().catch((error) => {
      this.connection = undefined
      throw error
    })
    return this.connection
  }

  /** The host's reads, with the person's words for a refusal. */
  private readonly read: AppshotRead = async (name, args) => {
    const client = await this.client()
    const result = await client.callTool(name, args, { timeout: 15_000 })
    if (result.isError)
      throw new Error(
        /window_id_not_found/.test(JSON.stringify(result))
          ? "That window has closed. Select it again from the window list."
          : "The window could not be captured. Check computer permissions and select the window again."
      )
    return result
  }

  /**
   * Warm the driver's first picture, once per daemon (the broker keeps
   * that). Callers go on at once; the promise is for a check that wants to
   * know when it's done.
   */
  warm(): Promise<void> {
    return this.driver.warm()
  }

  async windows(includeThumbnails = false): Promise<AppshotWindow[]> {
    const windows = await appshotWindows(this.read)
    void this.warm()
    const capturer = this.capturer()
    // Without a capturer the list is the driver's alone, with no pictures.
    if (!includeThumbnails || !capturer) return includeThumbnails ? windows.slice(0, 80) : windows
    const byId = new Map((await capturer.windows()).map((source) => [source.windowId, source]))
    return windows
      .filter((window) => byId.has(window.windowId))
      .slice(0, 80)
      .map((window) => {
        const source = byId.get(window.windowId)
        if (!source) return window
        const shown: AppshotWindow = { ...window, title: window.title || source.name }
        if (source.thumbnail) shown.thumbnail = source.thumbnail
        if (source.icon) shown.icon = source.icon
        return shown
      })
  }

  /** The window the person is in, never one of `exclude`'s (Mako, which they pressed the shortcut in); `front` is the app in front at the press, when the shortcut knows it. */
  async frontWindow(exclude: readonly number[], front?: number): Promise<AppshotWindow> {
    const window = await frontAppshotWindow(this.read, exclude, front === undefined ? this.front : () => Promise.resolve(front))
    void this.warm()
    return window
  }

  /** One Appshot, with its app's icon from the desktop's capturer when there is one that can say. */
  async capture(target: AppshotTarget, known?: AppshotWindow): Promise<Appshot> {
    const started = performance.now()
    const capturer = this.capturer()
    const [shot, icon] = await Promise.all([
      captureAppshot(this.read, target, {
        known,
        timed: (ms) => hostLog("appshot", "read", { pictureMs: ms.picture, treeMs: ms.tree }),
      }),
      known?.icon ? Promise.resolve(known.icon) : capturer?.icon ? capturer.icon(target.windowId).catch(() => null) : Promise.resolve(null),
    ])
    if (icon) shot.window.icon = icon
    hostLog("appshot", "captured", { ms: Math.round(performance.now() - started), elements: shot.elements ?? 0, truncated: shot.truncated })
    return shot
  }

  /** Resolve a live window for the desktop's video capture without walking AX or invalidating agent tokens. */
  async source(target: AppshotTarget): Promise<string | null> {
    const windows = await appshotWindows(this.read)
    if (!windows.some((window) => window.pid === target.pid && window.windowId === target.windowId)) return null
    return (await this.capturer()?.source(target.windowId)) ?? null
  }

  async close() {
    const connection = this.connection
    this.connection = undefined
    if (connection) await connection.then((client) => client.close()).catch(() => {})
  }
}
