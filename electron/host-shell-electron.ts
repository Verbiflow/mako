import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  type BrowserWindowConstructorOptions,
} from "electron"
import { watch } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { installAutomation } from "./automation.js"
import { backgroundLifecycle } from "./background-lifecycle.js"
import { electronPrivacy } from "./computer-permissions-electron.js"
import { electronNativeCrashes } from "./crash-electron.js"
import { guardDeskNavigation } from "./desk-browser-navigation.js"
import { deskPageForWindow } from "./desk-browser-window.js"
import { serveDesk } from "./desk-protocol.js"
import { DESK_BACKGROUND, DESK_TRAFFIC_LIGHTS, deskUrl, privilegedSchemes } from "./desk-scheme.js"
import { electronDesktopNotifier, surfaceWindow } from "./desktop-notifications-electron.js"
import { withHostClient } from "./host-client.js"
import { provideSafeStorage } from "./host-secrets.js"
import { hostLog, hostWarn } from "./host-log.js"
import type { HostShell, ShellHost } from "./host-shell.js"
import { installPageTransport } from "./ipc/register.js"
import { onMac } from "./platform.js"
import { watchPlugins } from "./plugins.js"
import { watchRendererHealth } from "./renderer-health.js"
import { electronWindowCapturer } from "./window-capture-electron.js"
import { adoptDeskOrigin } from "./renderer-storage.js"
import { electronSecretEncryption } from "./secure-storage-electron.js"

protocol.registerSchemesAsPrivileged(privilegedSchemes())

const __dirname = dirname(fileURLToPath(import.meta.url))
/**
 * A restart comes back on the current build. In dev the launcher keeps Vite
 * alive and respawns Electron when it exits with this code, because
 * `app.relaunch()` would return to a dev server that the launcher had already
 * torn down with the old process.
 */
const RELAUNCH_EXIT_CODE = 75

/** The host while Electron runs it: its own windows, file schemes and app events. */
export function electronShell(host: ShellHost): HostShell {
  const { environment, development, persistent } = host
  const disagreements = Object.entries({
    defaultDataRoot: [environment.defaultDataRoot, app.getPath("userData")],
    appData: [environment.appData, app.getPath("appData")],
    appRoot: [environment.appRoot, app.getAppPath()],
    version: [environment.version, app.getVersion()],
    packaged: [environment.packaged, app.isPackaged],
  } as const).filter(([, [ours, electron]]) => ours !== electron)
  app.setPath("userData", environment.dataRoot)
  provideSafeStorage(electronSecretEncryption())

  let window: BrowserWindow | null = null
  const rendererWindows = new Set<BrowserWindow>()
  /** Hidden windows agents drive; they never count as a window a person opened. */
  const deskWindows = new Set<BrowserWindow>()
  const clientOf = (renderer: BrowserWindow) => `renderer:${renderer.webContents.id}`

  installPageTransport((channel, call) =>
    ipcMain.handle(channel, async (event, ...args) => {
      const reply = await withHostClient(`renderer:${event.sender.id}`, () => call(args), true)
      return JSON.parse(reply).value
    })
  )
  app.on("window-all-closed", () => {
    if (!persistent && !onMac()) app.quit()
  })

  /**
   * The Dock and window icon.
   *
   * A raw square PNG is not a macOS icon: the system draws it exactly as given,
   * so it renders with hard corners and no margin — visibly larger and squarer
   * than everything beside it. Packaged macOS uses the bundle icon directly;
   * decoding another copy here retains tens of megabytes of CoreGraphics image
   * backing for no visual change. The explicit image is only for development and
   * platforms whose windows need one.
   */
  function appIcon() {
    const candidates = [
      join(__dirname, "../build/Mako.icns"),
      development
        ? join(__dirname, "../public/icons/app-icon.png")
        : join(__dirname, "../dist/icons/app-icon.png"),
    ]
    for (const file of candidates) {
      const image = nativeImage.createFromPath(file)
      if (!image.isEmpty()) return image
    }
    return undefined
  }

  function devServer(): string {
    const url = host.devServerUrl()
    if (!url) throw new Error("The development renderer is not registered")
    return url
  }

  function trackRenderer(renderer: BrowserWindow): void {
    rendererWindows.add(renderer)
    const client = clientOf(renderer)
    renderer.once("closed", () => {
      rendererWindows.delete(renderer)
      host.release(client)
    })
  }

  function denyNewWindows(target: BrowserWindow) {
    target.webContents.setWindowOpenHandler(({ url }) => {
      host.openLink(url)
      return { action: "deny" }
    })
  }

  /** The renderer document, with a preview id so the window keeps its own drafts. */
  async function loadDesk(target: BrowserWindow, previewId: string): Promise<void> {
    if (development) {
      const url = new URL(devServer())
      url.searchParams.set("preview", previewId)
      await target.loadURL(url.href)
    } else await target.loadURL(deskUrl({ preview: previewId }))
  }

  const page = (options: BrowserWindowConstructorOptions["webPreferences"]) => ({
    preload: host.preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    ...options,
  })

  async function createWindow() {
    nativeTheme.themeSource = "dark"
    if (development) {
      app.setName("Mako Dev")
      app.dock?.setBadge("DEV")
    }
    const icon = onMac() && environment.packaged ? undefined : appIcon()
    if (icon && onMac()) app.dock?.setIcon(icon)

    const windowOptions: BrowserWindowConstructorOptions = {
      title: development ? "Mako Dev" : "Mako",
      width: 1480,
      height: 940,
      minWidth: 900,
      minHeight: 620,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { ...DESK_TRAFFIC_LIGHTS },
      backgroundColor: DESK_BACKGROUND,
      show: false,
      // Agent processes live in the host; a hidden renderer can sleep safely.
      webPreferences: page({ backgroundThrottling: true }),
    }
    if (icon) windowOptions.icon = icon
    const opened = new BrowserWindow(windowOptions)
    window = opened
    trackRenderer(opened)

    opened.once("ready-to-show", () => {
      if (app.commandLine.hasSwitch("background")) return
      // Full working area, not a floating rectangle someone has to drag out.
      opened.maximize()
      opened.show()
    })

    // Renderer console output, in the terminal you started the app from.
    //
    // Without this the window is a black box: a component that throws leaves no
    // trace anywhere you are looking, which is exactly how a crash-on-boot went
    // unnoticed through a passing typecheck. Dev only — in a packaged build this
    // becomes the crash reporter's job, not stdout's.
    if (development) {
      opened.webContents.on("console-message", (details) => {
        const where = details.lineNumber ? ` (${details.sourceId}:${details.lineNumber})` : ""
        console.log(`[renderer:${details.level}] ${details.message}${where}`)
      })
    }

    watchRendererHealth(opened, { closing: () => !host.running() })
    installAutomation(opened, development)

    // Answer "is the app I am looking at current?" without guessing: in dev,
    // the compiled main process is watched, and the moment a rebuild lands on
    // disk the window says so. The renderer hot-reloads through Vite; the main
    // process cannot, and pretending otherwise is how stale builds get
    // debugged for an hour.
    if (development) {
      try {
        let told = false
        const buildWatcher = watch(join(__dirname, "main.js"), () => {
          if (told) return
          told = true
          setTimeout(() => {
            host.emit({
              type: "notice",
              level: "info",
              message: "Mako's engine was rebuilt — run Restart Mako from the palette to load it.",
            })
          }, 500)
        })
        opened.once("closed", () => buildWatcher.close())
      } catch {
        // Watching our own build is best-effort.
      }
    }

    // The agent writes a plugin with its ordinary file tools and the window
    // re-evaluates it — no IPC for it to learn, no command for the user to run.
    const watcher = watchPlugins(() => host.emit({ type: "plugins-changed" }))
    opened.once("closed", () => watcher?.close())
    opened.once("closed", () => {
      if (window === opened) window = null
    })
    denyNewWindows(opened)
    await opened.loadURL(development ? devServer() : deskUrl())
  }

  async function openPreviewWindow(): Promise<void> {
    const preview = new BrowserWindow({
      title: development ? "Mako Dev Preview" : "Mako Preview",
      width: 1200,
      height: 860,
      minWidth: 640,
      minHeight: 540,
      backgroundColor: DESK_BACKGROUND,
      show: false,
      webPreferences: page({ backgroundThrottling: true }),
    })
    trackRenderer(preview)
    denyNewWindows(preview)
    try {
      await loadDesk(preview, crypto.randomUUID())
      if (!app.commandLine.hasSwitch("background")) {
        await app.dock?.show()
        preview.show()
      }
    } catch (error) {
      preview.destroy()
      throw error
    }
  }

  async function deskPage(previewId: string) {
    const hidden = new BrowserWindow({
      title: development ? "Mako Dev Agent View" : "Mako Agent View",
      width: 1600,
      height: 1000,
      show: false,
      backgroundColor: DESK_BACKGROUND,
      enableLargerThanScreen: true,
      // Agents read this window through the protocol; it must keep painting.
      webPreferences: page({ backgroundThrottling: false }),
    })
    // macOS clamps a new window to the display; ask for the size again.
    hidden.setContentSize(1600, 1000)
    trackRenderer(hidden)
    deskWindows.add(hidden)
    hidden.once("closed", () => deskWindows.delete(hidden))
    guardDeskNavigation(hidden.webContents, host.isDeskUrl, (url) =>
      hostWarn("browser", "blocked hidden desk navigation", { url })
    )
    denyNewWindows(hidden)
    try {
      await loadDesk(hidden, previewId)
    } catch (error) {
      hidden.destroy()
      throw error
    }
    return deskPageForWindow(hidden)
  }

  /**
   * Standalone-host notifications. A click surfaces the desk window and tells
   * every renderer which subject was opened; previews ignore it, the desk acts.
   */
  const notifier = electronDesktopNotifier({
    idleBadge: development ? "DEV" : "",
    activate: (_windowId, activation) => {
      if (window) surfaceWindow(window)
      host.emit({ type: "notification-activated", ...activation })
    },
  })

  function hideWindows() {
    for (const renderer of rendererWindows) renderer.hide()
    app.dock?.hide()
  }

  /** Like the default profile's lock, its Dock presence is the installed app's alone. */
  function syncPresence() {
    // The host outlives every client, so it is often the only checked-in
    // instance of the app. LaunchServices cannot activate a process whose
    // registration is UIElement/hidden — `open`, the Dock, and launchers then
    // answer "The application is not open anymore". The default-profile host
    // keeps a regular, activatable presence while no client is attached and
    // hands it back when one is; other profiles stay headless.
    const ownsAppPresence = resolve(environment.dataRoot) === resolve(environment.defaultDataRoot)
    if (!ownsAppPresence) {
      app.dock?.hide()
      return
    }
    const sync = () => {
      if (host.socketClients() > 0) app.dock?.hide()
      else void app.dock?.show()
    }
    setInterval(sync, 2_000).unref()
    sync()
  }

  return {
    runtime: "electron",
    nativeCrashes: electronNativeCrashes,
    disagreements,
    // app.exit, not app.quit, so a window can't cancel an exit cleanup has already committed to.
    exit: (code, restart) => {
      if (restart && development && !persistent) app.exit(RELAUNCH_EXIT_CODE)
      else {
        if (restart) app.relaunch()
        app.exit(code)
      }
    },
    singleInstance: () => app.requestSingleInstanceLock(),
    ready: () => app.whenReady(),
    send: (channel, payload, client) => {
      for (const renderer of rendererWindows)
        if (!client || client === clientOf(renderer)) renderer.webContents.send(channel, payload)
    },
    clients: () => [...rendererWindows].map(clientOf),
    windowOpen: () => [...rendererWindows].some((renderer) => !deskWindows.has(renderer)),
    windowVisible: () => [...rendererWindows].some((renderer) => !renderer.isDestroyed() && renderer.isVisible()),
    hideWindows,
    reopen: async (create) => {
      await app.dock?.show()
      for (const renderer of rendererWindows) renderer.show()
      if (window && !window.isDestroyed()) window.focus()
      else if (create) await createWindow()
    },
    createWindow,
    openPreviewWindow,
    deskPage,
    notifier,
    privacy: electronPrivacy,
    capturer: electronWindowCapturer,
    updater: () => import("electron-updater"),
    notificationWindow: () => window?.webContents.id ?? 0,
    focusForPermission: () => {
      window?.show()
      window?.focus()
      app.focus({ steal: true })
    },
    start: async (files) => {
      if (persistent) syncPresence()
      app.setAboutPanelOptions({
        applicationName: "Mako",
        applicationVersion: environment.version,
        version: environment.version,
        copyright: "© 2026 Verbiflow",
        credits: "Desktop app for Claude Code, Codex, Cursor, Grok, Devin, and OpenCode.",
      })
      protocol.handle("mako-file", files)
      if (development) return
      serveDesk(host.rendererBundle, files)
      const moved = await adoptDeskOrigin({ userData: environment.dataRoot, dist: host.rendererBundle })
      if (moved.kind === "failed") hostWarn("renderer", "storage move failed", { error: moved.error })
      else if (moved.kind === "moved") hostLog("renderer", "storage moved", { origin: "mako-app://desk", entries: moved.entries })
    },
    onActivate: (listener) => {
      app.on("activate", listener)
      app.on("second-instance", listener)
    },
    onSystemShutdown: (listener) => powerMonitor.on("shutdown", listener),
    followQuit: (lifecycle, keepInBackground) => {
      const quit = backgroundLifecycle({ lifecycle, keepInBackground, hide: hideWindows })
      app.on("before-quit", quit.beforeQuit)
      app.on("will-quit", quit.willQuit)
    },
  }
}
