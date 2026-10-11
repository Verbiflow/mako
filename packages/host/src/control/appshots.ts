import { z } from "zod"
import {
  type ComputerBackend,
  connectMcpComputerDriver,
  type ComputerDriverClient,
  type ComputerDriverConnector,
} from "@mako/control-runtime/host"
import {
  type Appshot,
  type AppshotTarget,
  type AppshotWindow,
  type ControlImage,
  ControlImageSchema,
} from "@mako/control-runtime/contracts"

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
}

const windowList = z.object({
  windows: z
    .array(
      z.object({
        pid: z.number().int(),
        window_id: z.number().int(),
        app_name: z.string(),
        title: z.string(),
        is_on_screen: z.boolean(),
      })
    )
    .max(2000),
})
const response = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.json().optional(),
  content: z.array(z.json()),
})

/** Explicit window capture. This connection never focuses an app or sends input. */
export class Appshots {
  private connection: Promise<ComputerDriverClient> | undefined
  private readonly backend: () => Promise<ComputerBackend | null>
  private readonly connectDriver: ComputerDriverConnector
  private readonly capturer: () => WindowCapturer | undefined
  constructor(
    backend: () => Promise<ComputerBackend | null>,
    connectDriver: ComputerDriverConnector = connectMcpComputerDriver,
    capturer: () => WindowCapturer | undefined = () => undefined
  ) {
    this.backend = backend
    this.connectDriver = connectDriver
    this.capturer = capturer
  }

  private client(): Promise<ComputerDriverClient> {
    this.connection ??= (async () => {
      const backend = await this.backend()
      if (!backend)
        throw new Error("Appshots require the macOS computer-control driver.")
      const client = await this.connectDriver(backend)
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

  private async call(
    name: string,
    args: { [key: string]: number | boolean },
    signal?: AbortSignal
  ) {
    const client = await this.client()
    const result = response.parse(
      await client.callTool(name, args, {
        timeout: 15_000,
        signal,
      })
    )
    if (result.isError)
      throw new Error(
        "The window could not be captured. Check computer permissions and select the window again."
      )
    return result
  }

  async windows(includeThumbnails = false): Promise<AppshotWindow[]> {
    const result = await this.call("list_windows", { on_screen_only: true })
    const windows: AppshotWindow[] = windowList
      .parse(result.structuredContent)
      .windows.filter(
        (window) =>
          window.pid > 0 && window.window_id > 0 && window.is_on_screen
      )
      .map((window) => ({
        pid: window.pid,
        windowId: window.window_id,
        app: window.app_name,
        title: window.title,
      }))
      .sort(
        (a, b) => a.app.localeCompare(b.app) || a.title.localeCompare(b.title)
      )
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

  async capture(target: AppshotTarget): Promise<Appshot> {
    const window = (await this.windows()).find(
      (window) =>
        window.pid === target.pid && window.windowId === target.windowId
    )
    if (!window)
      throw new Error(
        "That window has closed. Select it again from the window list."
      )
    const result = await this.call("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      include_screenshot: true,
      max_elements: 1000,
      max_depth: 25,
    })
    const image = result.content
      .map((value) => ControlImageSchema.safeParse(value))
      .find((value) => value.success)?.data
    if (!image)
      throw new Error(
        "The selected window did not return a screenshot. Check Screen Recording permission and try again."
      )
    const context = z
      .object({
        tree_markdown: z.string().optional(),
        element_count: z.number().optional(),
        truncated: z.boolean().optional(),
        elements_complete: z.boolean().optional(),
      })
      .parse(result.structuredContent)
    const text =
      context.tree_markdown ??
      "No accessibility text was available for this window."
    return {
      window,
      capturedAt: Date.now(),
      image,
      text: text.slice(0, 100_000),
      truncated:
        text.length > 100_000 ||
        context.truncated === true ||
        context.elements_complete === false ||
        (context.element_count ?? 0) >= 1000,
    }
  }

  /** Resolve a live window for the desktop's video capture without walking AX or invalidating agent tokens. */
  async source(target: AppshotTarget): Promise<string | null> {
    const windows = await this.windows()
    if (
      !windows.some(
        (window) =>
          window.pid === target.pid && window.windowId === target.windowId
      )
    )
      return null
    return (await this.capturer()?.source(target.windowId)) ?? null
  }

  async close() {
    const connection = this.connection
    this.connection = undefined
    if (connection)
      await connection.then((client) => client.close()).catch(() => {})
  }
}
