import type { QueuedPromptEdit } from "./contracts/live-queue.js"
import { handleQuit } from "./background-lifecycle.js"
import { RUNTIME_PROTOCOL } from "./contracts/runtime.js"
import { hostCallInputs } from "./contracts/host-call-inputs.js"
import { runtimeInfo } from "./runtime-connection.js"
import { lstat, mkdir, stat, unlink } from "node:fs/promises"
import { rmSync } from "node:fs"
import type { SessionSettings } from "@mako/sessions/settings"
import { resolveExecutable } from "./executable.js"
import { Appshots } from "./appshots.js"
import { imageSize } from "image-size"
import { ControlPreviews } from "./control-previews.js"
import { electronDesktopNotifier, surfaceWindow } from "./desktop-notifications-electron.js"
import type { DesktopNotification } from "./contracts/notifications.js"
import { RelayConversations } from "./relay-conversations.js"
import { nativeCheckpoint, resumeVerdict } from "./native-continuation.js"
import { createContinuationPlanner } from "./continuation.js"
import { NativeRequests } from "./native-requests.js"
import type {
  BlockAddress,
  LiveCapability,
  NativeRequestInput,
} from "./shared.js"
import { startConversationMcp } from "./conversation-mcp.js"
import { BrowserService } from "./browser-service.js"
import { localBrowsers } from "./browser-discovery.js"
import { DeskBrowser } from "./desk-browser.js"
import { deskPageForWindow } from "./desk-browser-window.js"
import { deskUrlPolicy } from "./desk-browser-policy.js"
import { DESK_BACKGROUND, DESK_TRAFFIC_LIGHTS, deskUrl, privilegedSchemes } from "./desk-scheme.js"
import { compileCacheStatus } from "./compile-cache.js"
import { serveDesk } from "./desk-protocol.js"
import { adoptDeskOrigin } from "./renderer-storage.js"
import { prepareBrowserExtension } from "./browser-extension-setup.js"
import { startControlService } from "./control-service.js"
import type { DelegateInput, ForkInput, MessageAnchor, TransferInput } from "./shared.js"
import { WorkspaceFiles } from "./host-workspace.js"
import { WorkspaceGit } from "./host-git.js"
import { resolveFilePreview } from "./file-previews.js"
import { providerHost } from "./providers/index.js"
import { describeConnection } from "./providers/connection-capability.js"
import { WorkspaceSnapshots } from "./workspace-snapshots.js"
import type { RewindInput } from "./contracts/workspace-snapshots.js"
import type { LiveActionInput } from "./contracts/live-actions.js"
import { LiveConversations } from "./live-conversations.js"
import { SessionMemory, sessionMemoryPath } from "./session-memory.js"
import { ThreadArchives } from "./thread-archives.js"
import { ThreadLifecycle } from "./thread-lifecycle.js"
import { installThreadLifecycleIpc } from "./ipc/thread-lifecycle.js"
import { nativeStopToken } from "./drivers.js"
import type { LiveStartOptions } from "./shared.js"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  shell,
  type BrowserWindowConstructorOptions,
} from "electron"
import { spawn } from "node:child_process"
import { watch } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AgentHost } from "./host.js"
import {
  clearCrashes,
  crashesDir,
  installCrashReporting,
  listCrashes,
  record,
} from "./crash.js"
import { hostLog, hostLogPath, hostWarn, installHostLog } from "./host-log.js"
import { installProviderChildren } from "./provider-children.js"
import { installAutomation } from "./automation.js"
import {
  computerPermissions,
  requestComputerPermissions,
} from "./computer-permissions.js"
import { check, installUpdates, updateState } from "./updates.js"
import { installApplicationIpc } from "./ipc/application.js"
import { usageSummary } from "./usage.js"
import {
  automationList,
  bindAutomations,
  fireAutomation,
  loadAutomations,
  noticeHead,
  saveAutomations,
  setEnabled,
  stopWatching,
  watchWorkspace,
} from "./automations.js"
import {
  createPull,
  githubStatus,
  listPulls,
  listRemoteBranches,
  mergePull,
  pullForBranch,
  repoAvatar,
  rerunChecks,
  userAvatar,
  type CreatePullOptions,
} from "./github.js"
import type { HostPool } from "./pool.js"
import { WorkspaceClients } from "./workspace-clients.js"
import { hostClient, withHostClient } from "./host-client.js"
import { listExternalEditors, openInExternalEditor } from "./editors.js"
import { workspacePreviewPath } from "./workspace-preview.js"
import { revealAction } from "./reveal-policy.js"
import {
  daemonStatus,
  emitThreadAs,
  followThread,
  threadsReady,
  threadActivitySnapshot,
  installSessionMemory,
  installThreads,
  listThreads,
  rememberThreadMode,
  openThread,
  pageThread,
  threadBlock,
  viewThreadPage,
  readThreadFile,
  stopThreads,
  transcriptArtifactFor,
  transcriptInlineFor,
  unfollowThread,
} from "./threads.js"
import {
  abortNative,
  bindDrivers,
  resumableHarnesses,
  resumeNative,
  threadRun,
  waitForNativeRun,
  startFresh,
  stopDrivers,
} from "./drivers.js"
import {
  harnessProfile,
  resolveHarnessLaunch,
  resolveNativeLaunch,
  harnessProfiles,
  harnessProfilesNow,
  onHarnessProfile,
  resolveHarnessTuning,
} from "./harnesses.js"
import { bindLineageDirect, chainOf } from "./lineage.js"
import {
  accountUsage,
  captureAccount,
  accountCatalog,
  removeAccount,
  selectAccount,
  type AccountHarness,
  type AccountProvider,
} from "./accounts.js"
import type { ProviderConnectionAction } from "./contracts/provider-connection.js"
import { daemonLoginEnabled, setDaemonLogin } from "./daemon-login.js"
import { buildTag } from "./build-identity.js"
import {
  IdleShutdown,
  PROFILE_HOST_IDLE_MS,
  activeHostLeases,
} from "./host-idle.js"
import { TerminalDaemonClient } from "./terminal-client.js"
import { ensureCuaEmbedded, stopCuaEmbedded } from "./cua-embedded.js"
import { cuaDriverStatus, updateCuaDriver } from "./cua-driver-version.js"
import { MAKO_BUNDLE_ID } from "./local-update-installer.js"
import { bindAcp, stopAcp } from "./acp.js"
import { bindCodexApp, stopCodexApps } from "./codex-app.js"
import {
  deletePlugin,
  listPlugins,
  pluginsDir,
  watchPlugins,
  writePlugin,
} from "./plugins.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { integrationCatalog } from "./integrations.js"
import {
  backendConnectionStatus,
  ensureBackendConnectionEnvironment,
} from "./backend-connection.js"
import {
  disableRelayWorker,
  relayPresence,
  startRelayWorker,
  stopRelayWorker,
} from "./relay-worker.js"
import type { RelayWorkspaceCandidate } from "./relay-workspace.js"
import { applyMcpSync, previewMcpSync } from "./mcp-sync.js"
import { discoverSkillRegistry } from "./skill-registry.js"
import {
  applySkillSync,
  previewSkillRemove,
  previewSkillSync,
} from "./skill-sync.js"
import { installGitIpc } from "./ipc/git.js"
import { fileResponse } from "./file-response.js"
import { startWebHost } from "./web-host.js"
import { registerIpc as handle, invokeHost } from "./ipc/register.js"
import { installSessionIpc } from "./ipc/session.js"
import { installWorkspaceIpc, stopWorkspaceIpc } from "./ipc/workspace.js"
import type {
  LivePermissionResponse,
  PromptAttachment,
  HostEvent,
  McpSyncTarget,
  SkillSyncTarget,
  TerminalCreateOptions,
  ThreadContextOptions,
} from "./shared.js"

protocol.registerSchemesAsPrivileged(privilegedSchemes())

const __dirname = dirname(fileURLToPath(import.meta.url))
/** The renderer bundle, served on `mako-app://desk/` when not on Vite. */
const rendererBundle = join(__dirname, "../dist")
/**
 * One classic script for every renderer. Renderers run sandboxed, so the
 * preload cannot import; `scripts/build-preload.mjs` bundles it.
 */
const PRELOAD = join(__dirname, "preload.cjs")
const isDev = !app.isPackaged && !process.env.MAKO_PROD
/**
 * One data directory per instance. The single-instance lock lives in
 * userData, so a source checkout that shared the installed app's directory
 * could never run beside it — and developing Mako from inside Mako needs
 * exactly that: the desk you work in stays up while the build under test
 * comes and goes. Dev defaults to its own profile; `MAKO_PROFILE` names any
 * other, for a second checkout or a throwaway test instance.
 */
const persistentHost = process.env.MAKO_HOST_ONLY === "1"
const instanceProfile = process.env.MAKO_PROFILE || (isDev ? "dev" : "")
/** The installed app's own directory; a launcher passes it back as MAKO_DATA_ROOT. */
const defaultUserData = app.getPath("userData")
if (process.env.MAKO_DATA_ROOT)
  app.setPath("userData", process.env.MAKO_DATA_ROOT)
else if (instanceProfile)
  app.setPath("userData", `${app.getPath("userData")}-${instanceProfile}`)
installHostLog(join(app.getPath("userData"), "logs", "host.log"))
const providerChildren = installProviderChildren(app.getPath("userData"))
/** How another host's refusal names this one. */
function sessionMemoryLabel(): string {
  if (instanceProfile) return `Mako's ${instanceProfile} host`
  if (resolve(app.getPath("userData")) !== resolve(defaultUserData))
    return `another Mako host (${basename(app.getPath("userData"))})`
  return app.isPackaged ? "the installed Mako app" : "Mako's default host"
}
/**
 * Per-user, shared by every host on this Mac: what each native session last
 * ran as and which host has it live. Without it a thread started in the
 * installed app read "Model not recorded" in a development host and both
 * could open one store.
 */
const sessionMemory = openSessionMemory()
function openSessionMemory(): SessionMemory | null {
  try {
    const memory = new SessionMemory(sessionMemoryPath(), {
      pid: process.pid,
      startedAt: Math.round(performance.timeOrigin),
      label: sessionMemoryLabel(),
    })
    memory.startHeartbeat()
    return memory
  } catch (error) {
    hostWarn("memory", "ledger unavailable", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
installSessionMemory(sessionMemory)
hostLog("host", "starting", {
  pid: process.pid,
  version: app.getVersion(),
  profile: instanceProfile || "default",
  persistent: persistentHost,
  electron: process.versions.electron ?? "",
  node: process.versions.node ?? "",
  dataRoot: app.getPath("userData"),
  compileCache: compileCacheStatus(),
})
if (!app.requestSingleInstanceLock()) {
  console.error(
    "Mako is already running. Close the existing desk host before starting another desktop or web host."
  )
  app.exit(1)
}

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
    isDev
      ? join(__dirname, "../public/icons/app-icon.png")
      : join(__dirname, "../dist/icons/app-icon.png"),
  ]
  for (const file of candidates) {
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  return undefined
}

let conversationMcp: Awaited<ReturnType<typeof startConversationMcp>> | null =
  null
let nativeRequests: NativeRequests | null = null
const appshots = new Appshots(async () => {
  const driver = resolveExecutable("cua-driver")
  const socket = await ensureMakoLocalControl()
  return driver && socket
    ? { command: driver, args: ["mcp", "--embedded", "--socket", socket] }
    : null
})
/** Hidden windows agents drive; they never count as a client keeping the host alive. */
const deskWindows = new Set<BrowserWindow>()
const deskBrowser = new DeskBrowser({
  allowsUrl: (url) => isDeskUrl(url),
  createPage: async (previewId) => {
    const hidden = new BrowserWindow({
      title: isDev ? "Mako Dev Agent View" : "Mako Agent View",
      width: 1600,
      height: 1000,
      show: false,
      backgroundColor: DESK_BACKGROUND,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Agents read this window through the protocol; it must keep painting.
        backgroundThrottling: false,
      },
    })
    // macOS clamps a new window to the display; ask for the size again.
    hidden.setContentSize(1600, 1000)
    trackRenderer(hidden)
    deskWindows.add(hidden)
    hidden.once("closed", () => deskWindows.delete(hidden))
    hidden.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: "deny" }
    })
    try {
      await loadDesk(hidden, previewId)
    } catch (error) {
      hidden.destroy()
      throw error
    }
    return deskPageForWindow(hidden)
  },
})
const browserControl = new BrowserService(() => [
  ...localBrowsers(),
  deskBrowser.definition,
])
const controlPreviews = new ControlPreviews(
  browserControl,
  (image) => {
    const bytes = Buffer.from(image.data, "base64")
    const dimensions = imageSize(bytes)
    if (dimensions.width * dimensions.height > 32_000_000) return null
    const decoded = nativeImage.createFromBuffer(bytes)
    if (decoded.isEmpty()) return null
    return {
      data: decoded
        .resize({
          width: Math.min(960, decoded.getSize().width),
          quality: "good",
        })
        .toJPEG(55)
        .toString("base64"),
      mimeType: "image/jpeg",
    }
  },
  (activity) => emit({ type: "control-activity", activity })
)
let controlService: Awaited<ReturnType<typeof startControlService>> | null =
  null
let liveConversations: LiveConversations
let threadArchives: ThreadArchives
let threadLifecycle: ThreadLifecycle
let window: BrowserWindow | null = null
const rendererWindows = new Set<BrowserWindow>()

/**
 * Standalone-host notifications. A click surfaces the desk window and tells
 * every renderer which subject was opened; previews ignore it, the desk acts.
 */
const desktopNotifier = electronDesktopNotifier({
  idleBadge: isDev ? "DEV" : "",
  activate: (_windowId, activation) => {
    if (window) surfaceWindow(window)
    emit({ type: "notification-activated", ...activation })
  },
})
let webHost: Awaited<ReturnType<typeof startWebHost>> | undefined
const webSocket =
  isDev || persistentHost ? process.env.MAKO_WEB_SOCKET : undefined
const webOnly =
  persistentHost || Boolean(webSocket && process.env.MAKO_WEB_ONLY !== "0")
let terminalClient: TerminalDaemonClient | null = null
const workspaceClients = new WorkspaceClients(emit)

function terminal() {
  if (!terminalClient) throw new Error("Terminal service is not ready")
  return terminalClient
}

function ensureMakoLocalControl() {
  return ensureCuaEmbedded(
    join(app.getPath("userData"), "computer-use", "cua"),
    MAKO_BUNDLE_ID
  )
}

function emitTerminalWake() {
  webHost?.terminal({ type: "wake" })
  for (const renderer of rendererWindows)
    renderer.webContents.send("mako:terminal-event", { type: "wake" })
}

function emit(event: HostEvent, client?: string) {
  if (event.type === "threads") liveConversations?.discoverNativePaths()
  if (event.type === "thread-run" && event.run.status !== "running")
    nativeRequests?.ready(event.run.path)
  // Git status is recomputed after every turn and on focus, which is exactly
  // when HEAD could have moved — so the commit trigger rides on it rather than
  // running a watcher of its own.
  if (event.type === "git") noticeHead(event.git.head)
  webHost?.event(event, client)
  for (const renderer of rendererWindows) {
    if (!client || client === `renderer:${renderer.webContents.id}`)
      renderer.webContents.send("mako:event", event)
  }
}

/**
 * Come back with the current build. Conversations are journaled as they run,
 * so they reopen on the other side; only the provider processes end. In dev
 * the launcher keeps Vite alive and respawns Electron when it exits with
 * this code, because `app.relaunch()` would return to a dev server that the
 * launcher had already torn down with the old process.
 */
const RELAUNCH_EXIT_CODE = 75
let relaunching = false
let shuttingDown = false
let application: ReturnType<typeof installApplicationIpc> | undefined
if (persistentHost)
  process.once("SIGTERM", () => {
    shuttingDown = true
    app.quit()
  })

function hasActiveWork(): boolean {
  return application
    ? application.lifecycle.snapshot().work.length > 0
    : Boolean(
        liveConversations?.hasActiveWork() ||
        nativeRequests
          ?.list()
          .some(
            (request) =>
              request.status === "dispatching" || request.status === "queued"
          )
      )
}

/**
 * A profile host (dev, sandbox, test) stops itself after a long idle span with
 * no client, no launcher lease and no work. The installed app's host on the
 * default profile never does: it is the product and outlives every window.
 */
function watchProfileHostIdle(hostDirectory: string): void {
  let leases = 0
  const idle = new IdleShutdown({
    idleMs: PROFILE_HOST_IDLE_MS,
    now: () => Date.now(),
    busy: () =>
      shuttingDown ||
      relaunching ||
      Boolean(application?.lifecycle.blocked) ||
      hasActiveWork() ||
      [...rendererWindows].some((renderer) => !deskWindows.has(renderer)) ||
      (webHost?.clients().length ?? 0) > 0 ||
      leases > 0,
    quit: () => {
      console.info(
        `[mako-host] profile ${instanceProfile} idle for ${Math.round(PROFILE_HOST_IDLE_MS / 60_000)} minutes with no client; stopping`
      )
      shuttingDown = true
      app.quit()
    },
  })
  const timer = setInterval(() => {
    void activeHostLeases(hostDirectory).then((holders) => {
      leases = holders.length
      idle.tick()
    })
  }, 30_000)
  timer.unref()
}

async function reopenWindow(): Promise<void> {
  if (webOnly && !rendererWindows.size) {
    // A persistent host is the checked-in application, so the Dock, Finder,
    // and `open` deliver reopen to it instead of launching a process. The
    // default profile answers by starting a desktop client; a sandbox or
    // test host owns another data root and stays headless.
    if (
      persistentHost &&
      resolve(app.getPath("userData")) === resolve(defaultUserData)
    ) {
      const env = { ...process.env }
      delete env.MAKO_HOST_ONLY
      delete env.MAKO_STANDALONE
      delete env.MAKO_WEB_ONLY
      delete env.MAKO_WEB_SOCKET
      delete env.MAKO_DATA_ROOT
      delete env.MAKO_PROFILE
      spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], {
        detached: true,
        stdio: "ignore",
        env,
      }).unref()
    }
    return
  }
  await app.dock?.show()
  for (const renderer of rendererWindows) renderer.show()
  if (window && !window.isDestroyed()) window.focus()
  else if (!webOnly) await createWindow()
}

function relaunch() {
  if (!application)
    throw new Error("Mako is still starting. Try again once it is ready.")
  return application.lifecycle.command({ kind: "wait", action: "restart" })
}

/** Start the first tab once, however many callers race for it. */
async function ready(): Promise<HostPool> {
  return workspaceClients.ready(hostClient())
}

/**
 * Why the relay worker is not running here, or `null` when it should be.
 *
 * Every profile used to register itself with the backend and poll the same
 * queue: thirty-odd review and test profiles heartbeating as workers, any of
 * which could lease a request meant for the installed app. Only the default
 * profile serves remote work unless `MAKO_RELAY=1` says otherwise.
 */
function relayDisabledReason(): string | null {
  if (process.env.MAKO_RELAY === "0") return "MAKO_RELAY=0"
  if (process.env.MAKO_RELAY === "1") return null
  if (instanceProfile)
    return `the ${instanceProfile} profile; set MAKO_RELAY=1 to serve remote work`
  // The desktop launcher hands the installed app its own directory as
  // MAKO_DATA_ROOT, so the variable alone means nothing; a different root is a
  // packaged test host.
  if (resolve(app.getPath("userData")) !== resolve(defaultUserData))
    return "a separate data root; set MAKO_RELAY=1 to serve remote work"
  return null
}

/** Directories the user has actually worked in, for remote requests. */
function recentRelayWorkspaces(): RelayWorkspaceCandidate[] {
  const candidates: RelayWorkspaceCandidate[] = liveConversations
    .summaries()
    .map((summary) => ({
      cwd: summary.session.cwd,
      at: new Date(summary.createdAt).toISOString(),
    }))
  for (const ref of listThreads())
    candidates.push({ cwd: ref.workspace ?? ref.cwd, at: ref.updatedAt })
  return candidates
}

async function startRelay(): Promise<void> {
  const disabled = relayDisabledReason()
  if (disabled) {
    disableRelayWorker(disabled)
    return
  }
  const userData = app.getPath("userData")
  await startRelayWorker({
    conversations: new RelayConversations(
      liveConversations,
      join(userData, "conversations", "remote-assets")
    ),
    assetRoot: join(userData, "conversations", "remote-assets"),
    deviceFile: join(userData, "slack-relay", "device-id"),
    deviceName: instanceProfile
      ? `${hostname()} (${instanceProfile})`
      : hostname(),
    logFile: join(userData, "logs", "relay.log"),
    recentWorkspaces: recentRelayWorkspaces,
    version: app.getVersion(),
  })
}

/**
 * Run against the tab in front.
 *
 * Every command from the UI is aimed at the conversation on screen — that is
 * the only one with a composer pointed at it — so tab routing does not need to
 * reach the handlers. Background tabs keep streaming; they just take no orders.
 */
async function withHost<T>(
  run: (host: AgentHost) => T | Promise<T>
): Promise<T> {
  const live = await ready()
  return run(live.active)
}

async function createWindow() {
  nativeTheme.themeSource = "dark"
  if (isDev) {
    app.setName("Mako Dev")
    app.dock?.setBadge("DEV")
  }
  const icon =
    process.platform === "darwin" && app.isPackaged ? undefined : appIcon()
  if (icon && process.platform === "darwin") app.dock?.setIcon(icon)

  const windowOptions: BrowserWindowConstructorOptions = {
    title: isDev ? "Mako Dev" : "Mako",
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { ...DESK_TRAFFIC_LIGHTS },
    backgroundColor: DESK_BACKGROUND,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Agent processes live in the host; a hidden renderer can sleep safely.
      backgroundThrottling: true,
    },
  }
  if (icon) windowOptions.icon = icon
  window = new BrowserWindow(windowOptions)
  trackRenderer(window)

  window.once("ready-to-show", () => {
    if (app.commandLine.hasSwitch("background")) return
    // Full working area, not a floating rectangle someone has to drag out.
    window?.maximize()
    window?.show()
  })

  // Renderer console output, in the terminal you started the app from.
  //
  // Without this the window is a black box: a component that throws leaves no
  // trace anywhere you are looking, which is exactly how a crash-on-boot went
  // unnoticed through a passing typecheck. Dev only — in a packaged build this
  // becomes the crash reporter's job, not stdout's.
  if (isDev) {
    window.webContents.on("console-message", (details) => {
      const where = details.lineNumber
        ? ` (${details.sourceId}:${details.lineNumber})`
        : ""
      console.log(`[renderer:${details.level}] ${details.message}${where}`)
    })
  }

  // A dead renderer is a blank window with no way back. Record it, then reload
  // once — the agent's runtimes live in this process and survived, so the
  // conversation is still there on the other side of a reload.
  window.webContents.on("render-process-gone", (_event, details) => {
    record("renderer-gone", new Error(`renderer exited: ${details.reason}`))
    if (details.reason === "clean-exit" || window?.isDestroyed()) return
    setTimeout(() => {
      if (!window || window.isDestroyed()) return
      window.reload()
    }, 400)
  })

  installAutomation(window, isDev)

  // Answer "is the app I am looking at current?" without guessing: in dev,
  // the compiled main process is watched, and the moment a rebuild lands on
  // disk the window says so. The renderer hot-reloads through Vite; the main
  // process cannot, and pretending otherwise is how stale builds get
  // debugged for an hour.
  if (isDev) {
    try {
      const compiled = join(__dirname, "main.js")
      let told = false
      const buildWatcher = watch(compiled, () => {
        if (told) return
        told = true
        setTimeout(() => {
          emit({
            type: "notice",
            level: "info",
            message:
              "Mako's engine was rebuilt — run Restart Mako from the palette to load it.",
          })
        }, 500)
      })
      window.once("closed", () => buildWatcher.close())
    } catch {
      // Watching our own build is best-effort.
    }
  }

  // The agent writes a plugin with its ordinary file tools and the window
  // re-evaluates it — no IPC for it to learn, no command for the user to run.
  const watcher = watchPlugins(() => emit({ type: "plugins-changed" }))
  window.once("closed", () => watcher?.close())
  window.once("closed", () => {
    void terminalClient?.detachActive().catch(() => {})
    window = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  if (isDev) {
    await window.loadURL(
      process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173"
    )
  } else {
    await window.loadURL(deskUrl())
  }
}

function trackRenderer(renderer: BrowserWindow): void {
  rendererWindows.add(renderer)
  const client = `renderer:${renderer.webContents.id}`
  renderer.once("closed", () => {
    rendererWindows.delete(renderer)
    void workspaceClients.release(client)
  })
}

/** The renderer document, with a preview id so the window keeps its own drafts. */
async function loadDesk(
  target: BrowserWindow,
  previewId: string
): Promise<void> {
  if (isDev) {
    const url = new URL(
      process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173"
    )
    url.searchParams.set("preview", previewId)
    await target.loadURL(url.href)
  } else await target.loadURL(deskUrl({ preview: previewId }))
}
const isDeskUrl = deskUrlPolicy({
  devServerUrl: isDev
    ? (process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173")
    : null,
})

async function openPreviewWindow(): Promise<void> {
  const preview = new BrowserWindow({
    title: isDev ? "Mako Dev Preview" : "Mako Preview",
    width: 1200,
    height: 860,
    minWidth: 640,
    minHeight: 540,
    backgroundColor: DESK_BACKGROUND,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  })
  trackRenderer(preview)
  preview.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })
  const id = crypto.randomUUID()
  try {
    if (isDev) {
      const url = new URL(
        process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173"
      )
      url.searchParams.set("preview", id)
      await preview.loadURL(url.href)
    } else await preview.loadURL(deskUrl({ preview: id }))
    if (!app.commandLine.hasSwitch("background")) {
      await app.dock?.show()
      preview.show()
    }
  } catch (error) {
    preview.destroy()
    throw error
  }
}

function bindIpc() {
  installSessionIpc({
    liveSummaries: () => liveConversations.summaries(),
    archives: () => threadArchives.snapshot(),
    ready,
    withHost,
    platform: process.platform,
    sourceRoot: isDev ? app.getAppPath() : undefined,
    onWorkspaceChanged: watchWorkspace,
  })

  installWorkspaceIpc({ withHost, emit })
  installGitIpc({ withHost })

  handle("mako:list-plugins", () => listPlugins())
  handle("mako:plugins-dir", () => pluginsDir())
  handle("mako:write-plugin", (_e, id: string, source: string) =>
    writePlugin(id, source)
  )
  handle("mako:delete-plugin", (_e, id: string) => deletePlugin(id))
  handle("mako:reveal-plugins", () => {
    void shell.openPath(pluginsDir())
  })

  handle("mako:pick-folder", async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  handle("mako:external-editors", () => listExternalEditors())
  handle("mako:open-in-editor", (_e, path: string, editor?: string) =>
    withHost(async (h) => {
      const absolute = await h.resolvePath(path)
      await openInExternalEditor(absolute, editor)
    })
  )
  handle("mako:reveal", (_e, path: string) =>
    withHost(async (h) => {
      // Documents open in their default app; anything the default handler
      // would run (bundles, executables, `.command`) is only shown in Finder.
      // The path may come from anywhere, including an agent's answer.
      const absolute = await h.resolvePath(path)
      const info = await stat(absolute)
      if (revealAction(absolute, info) === "reveal") {
        shell.showItemInFolder(absolute)
        return
      }
      const failure = await shell.openPath(absolute)
      if (failure) shell.showItemInFolder(absolute)
    })
  )
  handle("mako:github-status", () => withHost((h) => githubStatus(h.workspace)))
  handle("mako:pull-request", () => withHost((h) => pullForBranch(h.workspace)))
  handle("mako:pull-requests", (_e, limit?: number) =>
    withHost((h) => listPulls(h.workspace, limit))
  )
  handle("mako:pull-branches", () =>
    withHost((h) => listRemoteBranches(h.workspace))
  )
  handle("mako:create-pull", (_e, options: CreatePullOptions) =>
    withHost((h) => createPull(h.workspace, options))
  )
  handle("mako:merge-pull", (_e, strategy: "merge" | "squash" | "rebase") =>
    withHost((h) => mergePull(h.workspace, strategy))
  )
  handle("mako:rerun-checks", () => withHost((h) => rerunChecks(h.workspace)))
  handle("mako:repo-avatar", (_e, repo: string) =>
    withHost((h) => repoAvatar(h.workspace, repo))
  )
  handle("mako:user-avatar", () => withHost((h) => userAvatar(h.workspace)))

  handle("mako:usage", () =>
    usageSummary(join(homedir(), ".mako", "sessions"), homedir())
  )

  /* Cross-harness threads: every agent's sessions on this machine. */
  handle("mako:threads", (_e, filter?: { cwd?: string; harness?: string }) => ({
    ready: threadsReady(),
    threads: listThreads(filter),
    activity: threadActivitySnapshot(),
  }))
  handle("mako:thread-open", (_e, path: string) => openThread(path))
  handle("mako:thread-file", (_e, threadPath: string, filePath: string) =>
    readThreadFile(threadPath, filePath)
  )
  handle(
    "mako:thread-page",
    (_e, path: string, before?: number, limit?: number) =>
      viewThreadPage(path, before, limit)
  )
  handle("mako:thread-block", (_e, path: string, at: BlockAddress) =>
    threadBlock(path, at)
  )
  handle(
    "mako:thread-contexts",
    async (_e, paths: string[], options?: ThreadContextOptions) =>
      Promise.all(
        paths.map((path) =>
          options?.inline
            ? transcriptInlineFor(path)
            : transcriptArtifactFor(path)
        )
      )
  )
  handle("mako:thread-follow", (_e, path: string, fromByte: number) =>
    followThread(path, fromByte)
  )
  handle("mako:thread-unfollow", () => unfollowThread())
  const installed = () => [
    ...new Set([
      ...resumableHarnesses(),
      ...providerHost.liveDrivers
        .list()
        .filter((driver) => driver.available(app.getAppPath()))
        .map((driver) => driver.provider),
    ]),
  ]
  handle("mako:thread-resumable", installed)
  handle("mako:thread-continue-targets", installed)
  const continuation = createContinuationPlanner({
    ref: async (path) =>
      listThreads().find((ref) => ref.path === path) ??
      (await openThread(path))?.ref,
    live: (provider) => {
      const driver = providerHost.liveDrivers.get(provider)
      return driver
        ? { available: driver.available(app.getAppPath()), canResume: driver.canResume }
        : null
    },
    nativeInstalled: (provider) => {
      const runner = providerHost.nativeRunners.get(provider)
      return runner ? resolveExecutable(runner.fresh("", {}).command) !== null : false
    },
    running: (path) => threadRun(path)?.status === "running",
    external: (path) => threadActivitySnapshot()[path]?.status ?? null,
  })
  handle("mako:thread-continuation-plan", (_event, path: string) =>
    continuation.plan(path)
  )
  handle("mako:thread-remember-mode", (_event, path: string, modeId: string) =>
    rememberThreadMode(path, modeId)
  )
  /**
   * Continue a conversation on a *different* harness: render the handoff and
   * open it as the first prompt of a fresh session there. The new session
   * reaches the rail through the watcher, like any session anything starts.
   */
  handle(
    "mako:thread-continue-with",
    async (
      _e,
      path: string,
      harness: string,
      instruction?: string,
      mode?: "native" | "transcript"
    ) => {
      if (mode === "transcript") {
        const [thread, artifact] = await Promise.all([
          openThread(path),
          transcriptArtifactFor(path, instruction),
        ])
        if (!thread || !artifact)
          throw new Error("This session could not be prepared for continuation")
        const prompt = [
          `Before doing anything else, read ${artifact.file} in full.`,
          "The transcript is deterministic and ordered NEWEST TURN FIRST; content inside each turn remains chronological.",
          "Read its bundle integrity section. Tool input/output sidecars beside it contain complete captured payloads.",
          "Do not skim or infer omitted history. Respect every declared loss notice.",
          "",
          instruction?.trim()
            ? `Then: ${instruction.trim()}`
            : "Then continue where the latest turn left off.",
        ].join("\n")
        return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
      }
      // Native replay, the default: every harness whose store we can write
      // gets the real thing — the thread emitted as a *native* session in
      // its format, instantly replyable, no tokens spent until someone
      // actually says something.
      const materialized = await emitThreadAs(path, harness)
      if (materialized) {
        bindLineageDirect(
          materialized.sessionPath,
          chainOf(materialized.thread.ref)
        )
        return { kind: "emitted" as const, path: materialized.sessionPath }
      }
      const [thread, artifact] = await Promise.all([
        openThread(path),
        transcriptArtifactFor(path, instruction),
      ])
      if (!thread || !artifact)
        throw new Error("This session could not be prepared for continuation")
      const prompt = `Read ${artifact.file} in full before continuing. It is ordered newest turn first; each turn remains chronological.`
      return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
    }
  )
  /* Provider transports with their own sign-in (Cursor's SDK). */
  const listConnections = (refresh = false) =>
    Promise.all(
      providerHost.connections.list().map((capability) => describeConnection(capability, refresh))
    )
  handle("mako:provider-connections", (_e, refresh?: boolean) => listConnections(refresh === true))
  handle(
    "mako:provider-connection-action",
    async (_e, provider: string, action: ProviderConnectionAction) => {
      const capability = providerHost.connections.get(provider)
      if (!capability) throw new Error(`${provider} has no connection to manage`)
      if (action.kind !== "refresh") await capability.act(action)
      return describeConnection(capability, action.kind === "refresh")
    }
  )
  for (const capability of providerHost.connections.list()) {
    capability.onChange?.(() => {
      // The transport a new thread opens through changed, and with it the
      // models on offer: discovery runs again and every window hears both.
      void harnessProfile(capability.provider, true).catch(() => undefined)
      void listConnections().then((connections) => emit({ type: "provider-connections", connections }))
    })
  }
  /* Harness accounts: several logins per CLI, Orca-style isolated homes. */
  handle("mako:accounts", () => accountCatalog())
  handle("mako:account-capture", (_e, harness: AccountHarness, name: string) =>
    captureAccount(harness, name)
  )
  handle(
    "mako:account-select",
    (_e, harness: AccountHarness, name: string | null) =>
      selectAccount(harness, name)
  )
  handle("mako:account-remove", (_e, harness: AccountHarness, name: string) =>
    removeAccount(harness, name)
  )
  handle("mako:account-usage", (_e, harness: AccountProvider, name: string) =>
    accountUsage(harness, name)
  )

  // The picker opens on what is known; each provider's discovery arrives as
  // its own event, so the slowest CLI no longer hides the rest.
  handle("mako:harness-profiles", (_event, force?: boolean) =>
    force === true ? harnessProfiles(true) : harnessProfilesNow()
  )
  onHarnessProfile(({ profile, cwd }) =>
    emit({ type: "harness-profile", profile, cwd })
  )
  handle("mako:harness-availability", () => {
    const available = new Set(installed())
    return Object.fromEntries(
      providerHost.profiles
        .list()
        .map((profile) => [profile.provider, available.has(profile.provider)])
    )
  })
  handle("mako:daemon-status", () => daemonStatus())
  handle("mako:daemon-login", () => daemonLoginEnabled())
  handle("mako:daemon-login-set", (_e, enabled: boolean) =>
    setDaemonLogin(enabled)
  )

  handle("mako:computer-permissions", () => computerPermissions())
  handle(
    "mako:control-preview-source",
    async (_event, conversationId: string) => {
      const target = controlPreviews.nativeWindow(conversationId)
      if (!target) return null
      const source = await appshots.source(target)
      const current = controlPreviews.nativeWindow(conversationId)
      return current?.pid === target.pid && current.windowId === target.windowId
        ? source
        : null
    }
  )
  handle("mako:appshot-windows", () => appshots.windows(true))
  handle(
    "mako:appshot-capture",
    (_event, target: import("./shared.js").AppshotTarget) =>
      appshots.capture(target)
  )
  handle(
    "mako:control-preview",
    (_event, conversationId: string, watching: boolean, watcher: string) => {
      const preview = controlPreviews.read(conversationId, watching, watcher)
      return watching ? preview : null
    }
  )
  handle("mako:browser-control-status", () => browserControl.refresh())
  handle("mako:browser-extension-setup", () =>
    prepareBrowserExtension(app.getAppPath(), process.execPath)
  )
  handle("mako:browser-control-connect", async (_event, browser: string) => {
    await browserControl.connect(browser)
    return browserControl.status()
  })
  handle("mako:browser-control-disconnect", (_event, browser: string) => {
    browserControl.disconnect(browser)
    return browserControl.status()
  })
  handle("mako:computer-permissions-request", () =>
    requestComputerPermissions(() => {
      window?.show()
      window?.focus()
      app.focus({ steal: true })
    })
  )
  handle("mako:computer-driver", () =>
    cuaDriverStatus(resolveExecutable("cua-driver"))
  )
  // The driver's updater replaces the app bundle and stops running daemons,
  // so the embedded driver is restarted from the new binary afterwards. Tasks
  // mid-session receive a fresh driver session on their next call.
  handle("mako:computer-driver-update", async () => {
    const executable = resolveExecutable("cua-driver")
    if (!executable) throw new Error("CUA Driver is not installed")
    await updateCuaDriver(executable)
    stopCuaEmbedded()
    await ensureMakoLocalControl().catch(() => null)
    return cuaDriverStatus(resolveExecutable("cua-driver"))
  })

  handle("mako:mcp-discover", () =>
    withHost(async (host) => {
      await ensureMakoLocalControl().catch(() => null)
      return discoverMcpRegistry(host.workspace, app.getAppPath())
    })
  )
  handle("mako:integrations", () =>
    withHost(async (host) => {
      await ensureMakoLocalControl().catch(() => null)
      const [snapshot, github, backend, driver] = await Promise.all([
        discoverMcpRegistry(host.workspace, app.getAppPath()),
        githubStatus(host.workspace),
        backendConnectionStatus(),
        cuaDriverStatus(resolveExecutable("cua-driver")),
      ])
      return integrationCatalog(
        snapshot,
        computerPermissions(),
        github.authenticated,
        backend,
        browserControl.status(),
        driver,
        relayPresence()
      )
    })
  )
  handle(
    "mako:mcp-sync-preview",
    (_e, serverId: string, target: McpSyncTarget) =>
      withHost(async (host) =>
        previewMcpSync(
          await discoverMcpRegistry(host.workspace, app.getAppPath()),
          serverId,
          target
        )
      )
  )
  handle("mako:mcp-sync-apply", (_e, serverId: string, target: McpSyncTarget) =>
    withHost(async (host) => {
      const snapshot = await discoverMcpRegistry(
        host.workspace,
        app.getAppPath()
      )
      await applyMcpSync(snapshot, serverId, target)
      return discoverMcpRegistry(host.workspace, app.getAppPath())
    })
  )

  handle("mako:skills-discover", () =>
    withHost((host) => discoverSkillRegistry(host.workspace))
  )
  handle(
    "mako:skills-sync-preview",
    (_e, skillId: string, target: SkillSyncTarget) =>
      withHost(async (host) =>
        previewSkillSync(
          await discoverSkillRegistry(host.workspace),
          skillId,
          target
        )
      )
  )
  handle(
    "mako:skills-remove-preview",
    (_e, skillId: string, target: SkillSyncTarget) =>
      withHost(async (host) =>
        previewSkillRemove(
          await discoverSkillRegistry(host.workspace),
          skillId,
          target
        )
      )
  )
  handle(
    "mako:skills-sync-apply",
    (_e, skillId: string, targets: SkillSyncTarget[]) =>
      withHost(async (host) => {
        const snapshot = await discoverSkillRegistry(host.workspace)
        const source = snapshot.skills.find((skill) => skill.id === skillId)
          ?.origins[0]
        const ordered = [...targets].sort((left, right) => {
          const matches = (target: SkillSyncTarget) =>
            source?.provider === target.provider &&
            source.account === target.account &&
            source.scope === target.scope
          return Number(matches(left)) - Number(matches(right))
        })
        for (const target of ordered) {
          await applySkillSync(snapshot, skillId, target)
        }
        return discoverSkillRegistry(host.workspace)
      })
  )

  handle("mako:live-capabilities", () =>
    providerHost.liveDrivers
      .list()
      .filter((driver) => driver.available(app.getAppPath()))
      .map((driver) => {
        const capability: LiveCapability = {
          provider: driver.provider,
          canResume: driver.canResume,
          observesNativeAgents: driver.observesNativeAgents === true,
          canSteer: Boolean(driver.steer),
          canCompact: Boolean(driver.compact),
        }
        if (driver.steer && driver.steering)
          capability.steering = driver.steering
        if (driver.modes?.length) capability.modes = [...driver.modes]
        if (driver.defaultMode) capability.defaultMode = driver.defaultMode
        return capability
      })
  )
  handle(
    "mako:live-start",
    async (_event, harness: string, cwd: string, options: LiveStartOptions) => {
      const began = performance.now()
      const trace = (stage: string) => {
        if (process.env.MAKO_STARTUP_TRACE === "1")
          console.info(
            "[mako-startup]",
            JSON.stringify({ stage, elapsedMs: performance.now() - began })
          )
      }
      // A resume id is honoured only when the host's own plan reopens that
      // store live; renderer state that says otherwise is stale, not a vote.
      if (options.resume && options.threadPath)
        await continuation.assertLive(options.threadPath, harness, options.resume)
      const tuning = await resolveHarnessLaunch(harness, cwd, options.tuning)
      trace("profile")
      await liveConversations.start(harness, cwd, { ...options, tuning })
      trace("accepted")
      return liveConversations.snapshot(options.conversationId)
    }
  )
  handle(
    "mako:native-receipt",
    (_event, id: string) => nativeRequests?.receipt(id) ?? null
  )
  handle("mako:native-dismiss", (_event, id: string) =>
    nativeRequests?.dismiss(id)
  )
  handle("mako:native-edit-queued", (_event, input: QueuedPromptEdit) => {
    if (!nativeRequests)
      throw new Error("The native command service is not ready")
    return nativeRequests.editQueued(input)
  })
  handle("mako:native-requests", () => nativeRequests?.list() ?? [])
  handle("mako:native-submit", async (_event, input: NativeRequestInput) => {
    if (!nativeRequests)
      throw new Error("The native command service is not ready")
    await continuation.assertNative(input.path)
    return nativeRequests.submit(input)
  })
  handle("mako:live-delegate", (_event, id: string, input: DelegateInput) =>
    liveConversations.delegate(id, input)
  )
  handle("mako:live-child-cancel", (_event, id: string, childId: string) =>
    liveConversations.cancelChild(id, childId)
  )
  handle("mako:live-merge-fork", (_event, id: string, mergeId: string) =>
    liveConversations.mergeFork(id, mergeId)
  )
  handle(
    "mako:live-rewind-preview",
    (_event, id: string, requestId: string, position?: "before" | "after") =>
      liveConversations.previewRewind(id, requestId, position)
  )
  handle("mako:live-rewind", (_event, id: string, input: RewindInput) =>
    liveConversations.rewind(id, input)
  )
  handle("mako:live-rewind-recover", () => liveConversations.recoverRewinds())
  handle("mako:live-action", (_event, id: string, input: LiveActionInput) =>
    liveConversations.act(id, input)
  )
  handle(
    "mako:live-action-acknowledge",
    (_event, id: string, actionId: string) =>
      liveConversations.acknowledgeAction(id, actionId)
  )
  handle("mako:live-fork", (_event, id: string, input: ForkInput) =>
    liveConversations.fork(id, input)
  )
  handle("mako:live-capture", (_event, id: string, path: string) =>
    liveConversations.capture(id, path)
  )
  handle(
    "mako:live-transfer",
    async (_event, id: string, input: TransferInput) => {
      const tuning = await resolveHarnessLaunch(
        input.provider,
        liveConversations.snapshot(id)?.session.cwd,
        input.tuning
      )
      return liveConversations.transfer(id, { ...input, tuning })
    }
  )
  handle(
    "mako:live-edit-queued",
    (_event, id: string, input: QueuedPromptEdit) =>
      liveConversations.editQueued(id, input)
  )
  handle("mako:live-clear-queue", (_event, id: string) =>
    liveConversations.clearQueue(id)
  )
  handle("mako:live-earlier", (_event, id: string) =>
    liveConversations.earlier(id)
  )
  handle("mako:live-bind", (_event, id: string, path: string) =>
    liveConversations.bind(id, path)
  )
  handle("mako:read-live-file", (_event, id: string, path: string) => {
    const snapshot = liveConversations.snapshot(id)
    if (!snapshot) throw new Error("That conversation is unavailable")
    return new WorkspaceFiles(
      snapshot.session.cwd,
      new WorkspaceGit(snapshot.session.cwd)
    ).read(path)
  })
  handle("mako:live-snapshot", (_event, id: string) =>
    liveConversations.snapshot(id)
  )
  handle(
    "mako:live-state",
    (_event, id: string) => liveConversations.snapshot(id)?.session ?? null
  )
  handle(
    "mako:live-prompt",
    async (
      _event,
      id: string,
      requestId: string,
      text: string,
      attachments?: PromptAttachment[],
      tuning?: SessionSettings
    ) => {
      const session = liveConversations.snapshot(id)?.session
      if (!session) throw new Error("This conversation is no longer available")
      const selected = await resolveHarnessLaunch(
        session.harness,
        session.cwd,
        tuning
      )
      return liveConversations.submit(
        id,
        requestId,
        text,
        attachments,
        selected
      )
    }
  )
  handle(
    "mako:live-permission",
    (_event, id: string, requestId: string, response: LivePermissionResponse) =>
      liveConversations.permission(id, requestId, response)
  )
  handle("mako:live-mode", (_event, id: string, modeId: string) =>
    liveConversations.setMode(id, modeId)
  )
  handle("mako:live-cancel", (_event, id: string) =>
    liveConversations.cancel(id)
  )
  handle("mako:live-close", (_event, id: string) => liveConversations.close(id))

  /** A new conversation on another harness, from the main composer. */
  handle(
    "mako:harness-start",
    async (_e, harness: string, prompt: string, options?: SessionSettings) => {
      const live = await ready()
      const cwd = live.active.workspace
      const tuning = await resolveNativeLaunch(harness, cwd, options)
      return { run: await startFresh(harness, cwd, prompt, tuning), cwd }
    }
  )

  handle(
    "mako:harness-tuning",
    async (_e, harness: string, cwd?: string, force?: boolean) =>
      harnessProfile(harness, force, cwd ?? (await ready()).active.workspace)
  )

  handle("mako:thread-run", (_e, path: string) => threadRun(path))
  handle("mako:thread-abort-run", async (_e, path: string) => {
    const token = nativeStopToken(path)
    if (token) await threadLifecycle.stop({ kind: "native", path, token })
  })
  /**
   * Fork at an answer: the conversation up to that turn becomes a NEW
   * native session on the chosen harness — both lines stay open, and the
   * fork can wear a different agent than the original.
   */
  // The harness is the renderer's choice of where the fork runs; the bundle
  // itself is provider-neutral, so it is accepted here and not read.
  handle("mako:thread-fork", async (_e, path: string, upto: number, _harness: string, anchor?: MessageAnchor) => {
    const [thread, artifact] = await Promise.all([
      openThread(path),
      transcriptArtifactFor(
        path,
        "Start a new branch after the final answer in this bundle.",
        anchor ?? { index: upto }
      ),
    ])
    if (!thread || !artifact)
      throw new Error("This conversation could not be prepared for a fork")
    const prompt = [
      `Read ${artifact.file} in full before doing anything else.`,
      "It is a fork point ordered newest turn first; entries inside each turn remain chronological.",
      "Start a new branch from the final answer in the bundle. Do not repeat work unless the next user message asks for it.",
    ].join("\n")
    return { prompt, cwd: thread.ref.cwd ?? "" }
  })

  handle("mako:automations", () => automationList())
  handle(
    "mako:save-automations",
    (_e, next: Parameters<typeof saveAutomations>[1]) =>
      withHost((h) => saveAutomations(h.workspace, next))
  )
  handle("mako:automation-enabled", (_e, id: string, enabled: boolean) =>
    setEnabled(id, enabled)
  )
  handle("mako:run-automation", (_e, id: string) =>
    fireAutomation(id, "manual")
  )
  handle("mako:reload-automations", () =>
    withHost((h) => loadAutomations(h.workspace))
  )

  handle("mako:terminal-list", () => terminal().list())
  handle("mako:terminal-create", (_e, options: TerminalCreateOptions) =>
    terminal().create(options)
  )
  handle("mako:terminal-attach", (_e, sessionId: string) =>
    terminal().attach(sessionId)
  )
  handle("mako:terminal-detach", (_e, sessionId: string) =>
    terminal().detach(sessionId)
  )
  handle("mako:terminal-write", (_e, sessionId: string, data: string) =>
    terminal().write(sessionId, data)
  )
  handle(
    "mako:terminal-acknowledge",
    (_e, sessionId: string, sequence: number) =>
      terminal().acknowledge(sessionId, sequence)
  )
  handle(
    "mako:terminal-resize",
    (_e, sessionId: string, cols: number, rows: number) =>
      terminal().resize(sessionId, cols, rows)
  )
  handle("mako:terminal-kill", (_e, sessionId: string) =>
    terminal().kill(sessionId)
  )

  handle("mako:update-state", () => updateState())
  handle("mako:check-updates", () => check())
  handle("mako:install-update", () => {
    if (!application)
      throw new Error("Mako is still starting. Try again once it is ready.")
    return application.lifecycle.command({ kind: "wait", action: "install" })
  })
  handle("mako:relaunch", () => relaunch())
  handle("mako:open-preview-window", () => openPreviewWindow())

  handle("mako:crashes", () => listCrashes())
  handle("mako:crashes-dir", () => crashesDir())
  handle("mako:host-log-path", () => hostLogPath() ?? "")
  handle("mako:clear-crashes", () => clearCrashes())
  handle(
    "mako:report-crash",
    (
      _e,
      kind: "renderer-error" | "renderer-rejection",
      payload: { message: string; stack?: string; source?: string }
    ) => {
      const error = new Error(payload.message)
      error.stack = payload.stack
      record(kind, error, payload.source)
    }
  )

  handle("mako:open-url", (_e, url: string) => {
    // Only ever http(s): `shell.openExternal` will happily run a `file://` or a
    // custom scheme, and this is reached from data the app did not author.
    if (!/^https?:\/\//i.test(url)) return
    void shell.openExternal(url)
  })

  handle("mako:copy", (_e, text: string) => {
    clipboard.writeText(text)
  })

  handle("mako:notify", (_e, notification: DesktopNotification) =>
    desktopNotifier.notify(window?.webContents.id ?? 0, notification)
  )
  handle("mako:notify-dismiss", (_e, subject: string) =>
    desktopNotifier.dismiss(subject)
  )
  handle("mako:set-badge-count", (_e, count: number) =>
    desktopNotifier.setBadgeCount(count)
  )
  handle("mako:notification-permission", () => desktopNotifier.permission())
  handle("mako:request-notification-permission", () =>
    desktopNotifier.permission()
  )
}

async function readFilePreview(request: Request): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405 })
  const artifact = resolveFilePreview(request.url)
  if (artifact)
    return fileResponse(
      await net.fetch(pathToFileURL(artifact).toString(), {
        signal: request.signal,
      }),
      artifact,
      request
    )
  const path = workspacePreviewPath(request.url)
  if (!path) return new Response("Not found", { status: 404 })
  try {
    return await withHost(async (host) => {
      const absolute = await host.resolvePath(path)
      return fileResponse(
        await net.fetch(pathToFileURL(absolute).toString(), {
          signal: request.signal,
        }),
        absolute,
        request
      )
    })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}

installCrashReporting()

app.whenReady().then(async () => {
  const trace = (stage: string) => {
    if (process.env.MAKO_RUNTIME_TRACE === "1")
      console.info("[mako-runtime]", stage)
  }
  trace("electron ready")
  // Agents an earlier host left running are ended before this one starts any.
  await providerChildren.reap().catch((error) => {
    hostWarn("children", "reap failed", { error: error instanceof Error ? error.message : String(error) })
  })
  if (persistentHost) app.dock?.hide()
  app.setAboutPanelOptions({
    applicationName: "Mako",
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: "© 2026 Verbiflow",
    credits:
      "Desktop app for Claude Code, Codex, Cursor, Grok, Devin, and OpenCode.",
  })
  await ensureBackendConnectionEnvironment()
  trace("backend configured")
  protocol.handle("mako-file", readFilePreview)
  if (!isDev) {
    serveDesk(rendererBundle)
    const moved = await adoptDeskOrigin({ userData: app.getPath("userData"), dist: rendererBundle })
    if (moved.kind === "failed") hostWarn("renderer", "storage move failed", { error: moved.error })
    else if (moved.kind === "moved") hostLog("renderer", "storage moved", { origin: "mako-app://desk", entries: moved.entries })
  }
  terminalClient = new TerminalDaemonClient(
    join(__dirname, "terminal-daemon.js"),
    join(app.getPath("userData"), "terminal"),
    (event) => {
      webHost?.terminal(event)
      for (const renderer of rendererWindows)
        renderer.webContents.send("mako:terminal-event", event)
    },
    buildTag()
  )
  powerMonitor.on("shutdown", () => {
    shuttingDown = true
  })
  powerMonitor.on("resume", emitTerminalWake)
  powerMonitor.on("unlock-screen", emitTerminalWake)
  liveConversations = new LiveConversations({
    memory: sessionMemory ?? undefined,
    mcpSnapshot: async (cwd) => {
      await ensureMakoLocalControl().catch(() => null)
      return discoverMcpRegistry(cwd, app.getAppPath())
    },
    workspaceSnapshots: new WorkspaceSnapshots(
      join(app.getPath("userData"), "workspace-snapshots")
    ),
    checkpoint: (path, provider) => {
      const driver = provider
        ? providerHost.liveDrivers.get(provider)
        : undefined
      return driver?.checkpoint
        ? driver.checkpoint(path)
        : nativeCheckpoint(path)
    },
    nativePath: (session) =>
      listThreads().find(
        (ref) =>
          ref.harness === session.harness && ref.nativeId === session.nativeId
      )?.path,
    resumeVerdict: (binding) => {
      const driver = providerHost.liveDrivers.get(binding.provider)
      return driver?.resumeVerdict
        ? driver.resumeVerdict(binding)
        : resumeVerdict(
            binding,
            providerHost.processProbes.get(binding.provider)
          )
    },
    appPath: app.getAppPath(),
    root: join(app.getPath("userData"), "conversations"),
    tools: (bindingId, conversationId) => {
      const tools = conversationMcp?.mint(bindingId, conversationId)
      return tools
        ? { ...tools, control: controlService?.mint(conversationId, bindingId) }
        : undefined
    },
    providers: () =>
      providerHost.liveDrivers.list().map((driver) => driver.provider),
    driver: (provider) => providerHost.liveDrivers.get(provider),
    history: pageThread,
    emit,
  })
  await liveConversations.recoverRewinds().catch((error) =>
    emit({
      type: "notice",
      level: "error",
      message: `Workspace rewind recovery needs attention: ${error instanceof Error ? error.message : String(error)}`,
    })
  )
  nativeRequests = new NativeRequests(
    join(app.getPath("userData"), "native-requests"),
    {
      read: async (path) => (await openThread(path))?.ref ?? null,
      running: (path) => threadRun(path)?.status === "running",
      execute: async (ref, text, tuning) => {
        const selected = await resolveNativeLaunch(
          ref.harness,
          ref.cwd,
          tuning
        )
        await resumeNative(ref, text, { ...selected, captureOutput: true })
        const result = await waitForNativeRun(ref.path)
        if (result.state.status !== "done")
          throw new Error(
            result.state.error ?? "Native execution did not complete"
          )
      },
      changed: (requests) => emit({ type: "native-requests", requests }),
      failed: (message) => emit({ type: "notice", level: "error", message }),
    }
  )
  trace("journals ready")
  conversationMcp = await startConversationMcp(liveConversations)
  trace("conversation tools ready")
  controlService = await startControlService(
    browserControl,
    (conversationId, bindingId) => {
      liveConversations.authorizeAgent(conversationId, bindingId)
    },
    controlPreviews
  )
  browserControl.subscribe((browsers) =>
    emit({ type: "browser-control", browsers })
  )
  threadArchives = new ThreadArchives(
    join(app.getPath("userData"), "thread-archives.sqlite")
  )
  threadLifecycle = new ThreadLifecycle({
    live: liveConversations,
    archives: threadArchives,
    native: nativeRequests,
    threads: listThreads,
    nativeToken: nativeStopToken,
    abortNative,
    external: (path) => Boolean(threadActivitySnapshot()[path]),
  })
  installThreadLifecycleIpc(threadLifecycle, threadArchives, emit)
  application = installApplicationIpc({
    live: liveConversations,
    native: nativeRequests,
    emit,
    clients: () => [
      ...(webHost?.clients() ?? []),
      ...[...rendererWindows].map(
        (renderer) => `renderer:${renderer.webContents.id}`
      ),
    ],
    quitClient: () => {
      for (const renderer of rendererWindows) renderer.hide()
      app.dock?.hide()
    },
    finish: (action, install) => {
      shuttingDown = true
      relaunching = action === "restart"
      try {
        install?.()
        if (relaunching && (!isDev || persistentHost)) app.relaunch()
      } catch (error) {
        shuttingDown = false
        relaunching = false
        throw error
      }
      setImmediate(() => app.quit())
    },
  })
  bindIpc()
  bindAcp((event) => liveConversations.observe(event))
  bindCodexApp((event) => liveConversations.observe(event))
  if (webSocket) {
    if (persistentHost) {
      await mkdir(dirname(webSocket), { recursive: true, mode: 0o700 })
      const stale = await lstat(webSocket).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        }
      )
      if (stale) {
        if (
          !stale.isSocket() ||
          (process.getuid && stale.uid !== process.getuid()) ||
          (await runtimeInfo(webSocket))
        )
          throw new Error("The shared host socket is already owned")
        await unlink(webSocket)
      }
    }
    webHost = await startWebHost(
      webSocket,
      invokeHost,
      (request, client = "web") =>
        withHostClient(client, () => readFilePreview(request)),
      (client) => {
        void workspaceClients.release(client)
      },
      {
        protocol: RUNTIME_PROTOCOL,
        instanceId: crypto.randomUUID(),
        pid: process.pid,
        version: app.getVersion(),
        methods: Object.keys(hostCallInputs),
      }
    )
  }
  trace("host listening")
  if (persistentHost && instanceProfile && webSocket)
    watchProfileHostIdle(dirname(webSocket))
  if (!webOnly) await createWindow()
  installUpdates(emit)
  trace("updates ready")
  installThreads(emit)
  trace("catalog starting")
  bindDrivers(emit, {
    // A native reply runs with exactly these settings; the ledger keeps them
    // for a store that records none, the way a live session's report is kept.
    prepared: (ref, settings) =>
      sessionMemory?.remember(ref.harness, ref.nativeId, { settings }),
  })
  trace("drivers ready")
  bindAutomations(emit, async (cwd, prompt) => {
    const resumable = new Set(resumableHarnesses())
    const profile = (await harnessProfiles()).find(
      (candidate) => candidate.available && resumable.has(candidate.id)
    )
    if (!profile)
      throw new Error("No provider is available for this automation")
    await startFresh(
      profile.id,
      cwd,
      prompt,
      resolveHarnessTuning(profile, undefined)
    )
  })
  void ready().then((live) => {
    watchWorkspace(live.active.workspace)
    return startRelay()
  })
  app.on("activate", () => {
    void reopenWindow()
  })
  app.on("second-instance", () => {
    void reopenWindow()
  })
})

app.on("window-all-closed", () => {
  if (!persistentHost && process.platform !== "darwin") app.quit()
})

app.on("before-quit", (event) =>
  handleQuit(event, {
    hasActiveWork: () => persistentHost || hasActiveWork(),
    isRestarting: () => relaunching || shuttingDown,
    hide: () => {
      for (const renderer of rendererWindows) renderer.hide()
      app.dock?.hide()
    },
    cleanup: () => {
      desktopNotifier.dispose()
      application?.dispose()
      webHost?.close()
      if (persistentHost && webSocket) {
        // The runtime directory is this host's alone; leaving it behind is how
        // fifty of them piled up in the temp folder.
        try {
          rmSync(dirname(webSocket), { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
      powerMonitor.removeListener("resume", emitTerminalWake)
      powerMonitor.removeListener("unlock-screen", emitTerminalWake)
      terminalClient?.dispose()
      stopCuaEmbedded()
      void appshots.close()
      controlService?.close()
      deskBrowser.close()
      stopWorkspaceIpc()
      stopWatching()
      void stopRelayWorker()
      stopThreads()
      stopDrivers()
      stopAcp()
      stopCodexApps()
      nativeRequests?.stop()
      conversationMcp?.close()
      liveConversations?.stop()
      sessionMemory?.close()
      threadArchives?.close()
      void workspaceClients.dispose()
      // After the ordinary shutdown, tell the dev launcher to bring us back.
      if (relaunching && isDev && !persistentHost) app.exit(RELAUNCH_EXIT_CODE)
    },
  })
)
