import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { BrowserService } from "@mako/control-runtime/browser"
import { localBrowsers, publishDeskBrowserRegistration } from "@mako/control-runtime/desktop"
import type { HostConfig } from "../host-config.js"
import type { MethodTable } from "../host-methods.js"
import { hostWarn } from "../host-log.js"
import { hostClient } from "../host-client.js"
import { Appshots } from "../appshots.js"
import { DesktopChannel } from "../desktop-channel.js"
import { AgentViewsApp } from "../agent-views.js"
import { AGENT_VIEWS_CLIENT, clientRoot } from "../runtime-service.js"
import { ControlPreviews, previewThumbnail } from "../control-previews.js"
import { DeskBrowser } from "../desk-browser.js"
import { deskUrlPolicy } from "../desk-browser-policy.js"
import { watchDevRendererRegistration } from "../dev-renderer-registration.js"
import { prepareBrowserExtension } from "../browser-extension-setup.js"
import { browserApplicationIcon } from "../browser-icon.js"
import { ControlSessions } from "../control-sessions.js"
import { startControlService } from "../control-service.js"
import { resolveExecutable } from "../executable.js"
import { ensureCuaEmbedded, stopCuaEmbedded } from "../cua-embedded.js"
import { cuaDriverStatus, updateCuaDriver } from "../cua-driver-version.js"
import { MAKO_BUNDLE_ID, desktopLaunchEnvironment } from "../local-update-installer.js"
import { computerPermissions } from "../computer-permissions.js"
import { desktopUpdateChanged } from "../updates.js"
import { hostMachine } from "../machine.js"
import { nodePlatform } from "../platform.js"
import type { MakoComputerPermissions } from "../contracts/mcp-skills-integrations.js"
import type { AppshotTarget, HostEvent } from "../shared.js"

/** Browser and computer use, and the desktop app that does what only Electron can. */
export interface Control {
  /**
   * The desktop app attached on `/desktop`, for what only Electron's main
   * process can do: Mako.app's grants, window capture, its own update, and the
   * desk windows agents drive. Without one the host goes without, except for
   * those windows, which the agent views app makes.
   */
  desktop: DesktopChannel
  appshots: Appshots
  browser: BrowserService
  previews: ControlPreviews
  sessions: ControlSessions
  /** The renderer a development host's windows load now; another checkout's dev server can register while it runs. */
  devServerUrl(): string | null
  /** Mako's own computer-use driver, started once and shared. */
  ensureLocalControl(): Promise<string | null>
  /** Mako.app's grants as the desktop reads them; without a desktop, macOS can't say which app holds them. */
  computerPermissions(): Promise<MakoComputerPermissions>
  /** Agents' browser access, once the conversations exist to authorize them. */
  startService(authorize: (conversationId: string, bindingId: string) => void): Promise<ControlService>
  stop(): void
}

export type ControlService = Awaited<ReturnType<typeof startControlService>>

export function openControl(config: HostConfig, emit: (event: HostEvent) => void): Control {
  const { environment, fixtureDesk } = config
  const configuredDevServerUrl = config.development?.devServerUrl ?? null
  let activeDevServerUrl = configuredDevServerUrl
  const desktop = new DesktopChannel({ updated: () => desktopUpdateChanged() })
  const agentViews = new AgentViewsApp({
    channel: desktop,
    launch: () => config.desktopExecutable ? {
      executable: config.desktopExecutable,
      args: environment.packaged ? [] : [environment.appRoot],
      env: {
        ...desktopLaunchEnvironment(process.env),
        MAKO_DATA_ROOT: environment.dataRoot,
        ...(environment.profile && { MAKO_PROFILE: environment.profile }),
        ...(process.env.MAKO_PROD && { MAKO_PROD: process.env.MAKO_PROD }),
        ...(activeDevServerUrl && { VITE_DEV_SERVER_URL: activeDevServerUrl }),
      },
      log: join(clientRoot(environment.dataRoot, AGENT_VIEWS_CLIENT), "logs", "desktop.log"),
    } : undefined,
  })
  const ensureLocalControl = () => ensureCuaEmbedded(join(environment.dataRoot, "computer-use", "cua"), MAKO_BUNDLE_ID)
  const appshots = new Appshots(async () => {
    const driver = resolveExecutable("cua-driver")
    const socket = await ensureLocalControl()
    return driver && socket
      ? { command: driver, args: ["mcp", "--embedded", "--socket", socket] }
      : null
  }, undefined, () => desktop.answers("window-thumbnails") ? desktop.capturer() : undefined)
  const isDeskUrl = (url: string) => deskUrlPolicy({ devServerUrl: config.development ? activeDevServerUrl : null })(url)
  const deskBrowser = new DeskBrowser({
    fixture: fixtureDesk,
    allowsUrl: (url) => isDeskUrl(url),
    createPage: async (previewId) => {
      await agentViews.ready()
      return desktop.deskPage(previewId)
    },
  })
  const readComputerPermissions = (): Promise<MakoComputerPermissions> =>
    desktop.answers("computer-permissions") ? desktop.ask("computer-permissions", {}) : Promise.resolve(computerPermissions(undefined))
  let defaultBrowserApplication: Promise<string | undefined> | undefined
  const preferredBrowserApplication = () => {
    const machine = hostMachine()
    return (defaultBrowserApplication ??= machine.kind === "present" ? machine.defaultBrowser() : Promise.resolve(undefined))
  }
  // The application owns checkout resources; the reusable Node runtime does not
  // infer workspace paths. Child control servers receive the same explicit root.
  const developmentMedia = join(environment.appRoot, "vendor/control-media", `${nodePlatform()}-${process.arch}`)
  if (!environment.packaged && existsSync(developmentMedia))
    process.env.MAKO_CONTROL_MEDIA_ROOT ??= developmentMedia
  const browser = new BrowserService(
    async () => {
      const defaultPath = await preferredBrowserApplication()
      const browsers = await localBrowsers(defaultPath ? [defaultPath] : [])
      return [
        ...(await Promise.all(
          browsers.map(async (found) => {
            const path = found.applicationPath
            if (!path) return found
            return { ...found, icon: await browserApplicationIcon(path) }
          })
        )),
        deskBrowser.definition,
      ]
    },
    {
      preferencePath: join(environment.dataRoot, "browser-preference.json"),
      defaultApplication: preferredBrowserApplication,
    }
  )
  let devRendererGeneration = 0
  let removeDeskBrowserRegistration: (() => void) | undefined
  async function configureDevRenderer(registration: { profile: string; sourceRoot: string; url: string } | null): Promise<void> {
    const generation = ++devRendererGeneration
    activeDevServerUrl = registration?.url ?? configuredDevServerUrl
    removeDeskBrowserRegistration?.()
    removeDeskBrowserRegistration = undefined
    if (!registration) {
      await browser.refresh()
      return
    }
    try {
      const endpoint = await deskBrowser.start()
      if (generation !== devRendererGeneration) return
      removeDeskBrowserRegistration = publishDeskBrowserRegistration({
        endpoint,
        origin: new URL(registration.url).origin,
        profile: registration.profile,
        sourceRoot: registration.sourceRoot,
        fixture: fixtureDesk,
      })
    } catch (error) {
      hostWarn("browser", "dev desk registration failed", { error: error instanceof Error ? error.message : String(error) })
    }
    await browser.refresh()
  }
  const stopDevRendererWatch = config.development
    ? watchDevRendererRegistration(
        dirname(config.socket),
        { profile: environment.profile || "dev", sourceRoot: environment.appRoot },
        (registration) => void configureDevRenderer(registration)
      )
    : undefined
  const previews = new ControlPreviews(browser, previewThumbnail, (activity) => emit({ type: "control-activity", activity }))
  const sessions = new ControlSessions(async () => {
    const driver = resolveExecutable("cua-driver")
    if (!driver) return undefined
    const socket = await ensureLocalControl()
    return socket ? { driver, socket } : undefined
  })
  const unsubscribe = browser.subscribe((browsers) => emit({ type: "browser-control", browsers }))
  let service: ControlService | undefined
  return {
    desktop,
    appshots,
    browser,
    previews,
    sessions,
    devServerUrl: () => activeDevServerUrl,
    ensureLocalControl,
    computerPermissions: readComputerPermissions,
    async startService(authorize) {
      service = await startControlService(browser, authorize, previews)
      return service
    },
    stop() {
      void sessions.close()
      stopCuaEmbedded()
      void appshots.close()
      agentViews.close()
      desktop.close()
      service?.close()
      stopDevRendererWatch?.()
      devRendererGeneration += 1
      removeDeskBrowserRegistration?.()
      removeDeskBrowserRegistration = undefined
      deskBrowser.close()
      unsubscribe?.()
    },
  }
}

/** Browser and computer use, the previews of what agents drive, and Mako.app's grants. */
export function declareControlMethods(methods: MethodTable, control: Control, appRoot: string, executable: string): void {
  const { appshots, browser, previews, desktop } = control
  methods.handle("mako:computer-permissions", () => control.computerPermissions())
  methods.handle("mako:control-preview-source", async (conversationId: string) => {
    const target = previews.nativeWindow(conversationId)
    if (!target) return null
    const source = await appshots.source(target)
    const current = previews.nativeWindow(conversationId)
    return current?.pid === target.pid && current.windowId === target.windowId ? source : null
  })
  methods.handle("mako:appshot-windows", () => appshots.windows(true))
  methods.handle("mako:appshot-capture", (target: AppshotTarget) => appshots.capture(target))
  methods.handle(
    "mako:control-preview",
    (conversationId: string, watching: boolean, watcher: string, box?: { width: number; height: number }) => {
      const preview = previews.read(conversationId, watching, watcher, hostClient())
      return watching && preview ? previews.sized(preview, box) : null
    }
  )
  methods.handle("mako:control-preview-viewers", (conversationId: string) => previews.viewers(conversationId, hostClient()))
  methods.handle("mako:browser-control-status", () => browser.refresh())
  methods.handle("mako:browser-control-prefer", (preferred: string | null) => browser.prefer(preferred))
  methods.handle("mako:browser-extension-setup", () => prepareBrowserExtension(appRoot, executable))
  methods.handle("mako:browser-control-connect", async (name: string) => {
    await browser.connect(name)
    return browser.status()
  })
  methods.handle("mako:browser-control-disconnect", (name: string) => {
    browser.disconnect(name)
    return browser.status()
  })
  methods.handle("mako:computer-permissions-request", () => {
    if (!desktop.answers("computer-permissions-request")) throw new Error("Open Mako's desktop app on this Mac to grant computer permissions.")
    return desktop.ask("computer-permissions-request", {})
  })
  methods.handle("mako:computer-driver", () => cuaDriverStatus(resolveExecutable("cua-driver")))
  // The driver's updater replaces the app bundle and stops running daemons,
  // so the embedded driver is restarted from the new binary afterwards. Tasks
  // mid-session receive a fresh driver session on their next call.
  methods.handle("mako:computer-driver-update", async () => {
    const found = resolveExecutable("cua-driver")
    if (!found) throw new Error("CUA Driver is not installed")
    await updateCuaDriver(found)
    stopCuaEmbedded()
    await control.ensureLocalControl().catch(() => null)
    return cuaDriverStatus(resolveExecutable("cua-driver"))
  })
}
