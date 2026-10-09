import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, powerMonitor, protocol, shell, type IpcMainInvokeEvent } from "electron"
import { WindowShutdown } from "./window-shutdown.js"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, access, mkdtemp, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { hostCallInput, hostChannels } from "./contracts/host-call-inputs.js"
import { answerClientCall, isClientCall, openableLink, type ClientAnswers } from "./contracts/client-calls.js"
import { MachineOfferSchema, UNSTATED_MACHINE_OFFER, type MachineOffer } from "./contracts/machine-offer.js"
import { AGENT_VIEWS_ENV, type DesktopRole } from "./contracts/desktop-channel.js"
import { FixtureDeskRefusedError, fixtureDeskRefusal } from "./contracts/fixture-desk-policy.js"
import { AGENT_VIEWS_CLIENT, clientRoot, ensureRuntime, runtimeDataRoot, runtimeLocation } from "./runtime-service.js"
import { invokeRuntime, invokeRuntimePreview, runtimeFile, settleRuntime, subscribeRuntime } from "./runtime-connection.js"
import { invokeWithRecovery, type RecoveryLink } from "./runtime-retry.js"
import { HOST_OUTAGE_MESSAGE } from "./contracts/host-connection.js"
import { electronDesktopNotifier, surfaceWindow } from "./desktop-notifications-electron.js"
import { DESK_BACKGROUND, DESK_TRAFFIC_LIGHTS, deskUrl, privilegedSchemes } from "./desk-scheme.js"
import { serveDesk } from "./desk-protocol.js"
import { adoptDeskOrigin } from "./renderer-storage.js"
import { breadcrumb, clearCrashes, crashesDir, installCrashReporting, listCrashes, record } from "./crash.js"
import { electronNativeCrashes } from "./crash-electron.js"
import { flushHostLog, hostLog, installHostLog } from "./host-log.js"
import { watchRendererHealth } from "./renderer-health.js"
import { buildIdentity } from "./build-identity.js"
import { userRootFor } from "./host-environment.js"
import { dataKeyPath } from "./host-secrets.js"
import { SecretKeyLink } from "./secret-key-link.js"
import { electronSecretEncryption } from "./secure-storage-electron.js"
import { DesktopLink } from "./desktop-link.js"
import { deskPageAnswers, machineAnswers } from "./desktop-answers-electron.js"
import { desktopUpdates, type DesktopUpdates } from "./desktop-updates-electron.js"
import { packagedDistribution } from "./distribution.js"
import { deskUrlPolicy } from "./desk-browser-policy.js"
import { guardDeskNavigation } from "./desk-browser-navigation.js"
import { installAutomation } from "./automation.js"

const directory = dirname(fileURLToPath(import.meta.url))
/**
 * The app a person opened, or the agent views app a host started to make
 * the desk windows agents drive while no desktop is open (`agent-views.ts`):
 * no Dock icon, no window of its own, nothing about the person's Mac, and it
 * never starts a host.
 */
const role: DesktopRole = process.env[AGENT_VIEWS_ENV] === "1" ? "agent-views" : "desktop"
/** The agent views app ends itself once it has had no window this long. */
const AGENT_VIEWS_IDLE_MS = 60_000
const isDev = !app.isPackaged && !process.env.MAKO_PROD
const dataRoot = runtimeDataRoot(app.getPath("appData"), process.env)
const flavor = role === "agent-views"
  ? AGENT_VIEWS_CLIENT
  : process.env.MAKO_CLIENT_ID ?? (isDev ? `dev-${createHash("sha256").update(app.getAppPath()).digest("hex").slice(0, 12)}` : "desktop")
const uiRoot = clientRoot(dataRoot, flavor)
app.setPath("userData", uiRoot)
installHostLog(join(uiRoot, "logs", "desktop.log"))
installCrashReporting({ root: uiRoot, directory: join(dataRoot, "crashes"), source: `desktop pid=${process.pid}`, native: electronNativeCrashes })
hostLog("desktop", "starting", { pid: process.pid, build: buildIdentity()?.id, version: app.getVersion(), dataRoot, uiRoot })
protocol.registerSchemesAsPrivileged(privilegedSchemes())
const rendererBundle = join(directory, "../dist")

const launch = { dataRoot, executable: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()], cwd: process.cwd(), env: process.env }
const clients = new Map<number, { id: string; connected: boolean; link: RecoveryLink; dispose(): void }>()
const DISCONNECTED_MESSAGE = HOST_OUTAGE_MESSAGE
let runtime: Awaited<ReturnType<typeof ensureRuntime>>
let secretKeys: SecretKeyLink | undefined
let desktopLink: DesktopLink | undefined
let updates: DesktopUpdates | undefined
let agentViewsIdle: ReturnType<typeof setTimeout> | undefined
/** Hidden windows hosts asked for, for agents to drive: never a window the person keeps open. */
const agentViews = new Set<number>()
const personWindows = () => BrowserWindow.getAllWindows().filter((window) => !agentViews.has(window.webContents.id))
let shuttingDown = false
let pendingCommand: "app.quit" | "app.updates" | null = null
let shutdownAction: "quit" | "install" | "restart" | null = null
const draftShutdown = new WindowShutdown()
let closingLocally = false

/**
 * Notifications and the badge belong to this client, not the shared host: the
 * banner is for the desk you looked away from, and the badge for its dock
 * icon. A click surfaces the window that asked and hands it the subject.
 */
const desktopNotifier = electronDesktopNotifier({
  idleBadge: "",
  activate: (windowId, activation) => {
    const target = personWindows().find((candidate) => candidate.webContents.id === windowId) ?? personWindows()[0]
    if (!target || target.isDestroyed()) return
    surfaceWindow(target)
    target.webContents.send("mako:event", { type: "notification-activated", ...activation })
  },
})

function requestCommand(command: "app.quit" | "app.updates"): void {
  const window = BrowserWindow.getFocusedWindow() ?? personWindows()[0]
  if (window && !window.webContents.isLoadingMainFrame()) { window.show(); window.webContents.send("mako:event", { type: "app-command", command }) }
  else {
    pendingCommand = command
    if (!window) void openWindow().catch((error) => dialog.showErrorBox("Mako could not open", error instanceof Error ? error.message : "Try opening Mako again."))
  }
}

/** Closes this client once every window has saved its draft; the shared host and its agents keep running. */
function closeClient(): Promise<void> {
  closingLocally = true
  return draftShutdown.request([...clients.keys()].filter((id) => !agentViews.has(id)).map(String), (requestId) => {
    for (const window of personWindows()) window.webContents.send("mako:event", { type: "app-shutdown", requestId, action: "quit" })
  }).then(() => { shuttingDown = true; app.quit() })
}

/**
 * A signal comes from the system or a process manager, not a person, so the
 * client closes as "Quit and keep agents running" does, without asking. A
 * window that can't save its draft in time, or a second signal, ends it anyway.
 *
 * Called after `ready`, when Electron installs handlers that would ask through
 * the quit dialog instead. Node takes a signal back from Electron only when
 * the signal's first listener is added, and signal-exit (through
 * proper-lockfile) listened while modules loaded, so every listener is
 * removed and added again, after this one, so signal-exit never finds itself
 * alone and re-raises.
 */
function closeOnSignals(): void {
  let signalled = false
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const earlier = process.listeners(signal)
    process.removeAllListeners(signal)
    process.on(signal, () => {
      if (signalled) { app.exit(0); return }
      signalled = true
      hostLog("desktop", "closing on signal", { pid: process.pid, signal })
      void closeClient().catch((error) => {
        hostLog("desktop", "closing without saved drafts", { pid: process.pid, reason: error instanceof Error ? error.message : String(error) })
        app.exit(0)
      })
    })
    for (const listener of earlier) process.on(signal, listener)
  }
}

function finishClientShutdown(): void {
  if (!shutdownAction || shuttingDown || personWindows().length) return
  // This app's own update: the host asks for the install once its work has stopped (`update-install`).
  if (shutdownAction === "install" && updates?.ready()) return
  shuttingDown = true
  if (shutdownAction === "restart") app.relaunch()
  app.quit()
}

/** What this client answers on its own Mac, never the shared host (`contracts/client-calls.ts`). */
const clientAnswers: ClientAnswers<IpcMainInvokeEvent> = {
  "mako:open-url": async (_event, url) => {
    const link = openableLink(url)
    if (!link) throw new Error("Mako opens only http and https links")
    await shell.openExternal(link)
  },
  "mako:copy": (_event, text) => { clipboard.writeText(text) },
  "mako:notify": (event, notification) => desktopNotifier.notify(event.sender.id, notification),
  "mako:notify-dismiss": (_event, subject) => { desktopNotifier.dismiss(subject) },
  "mako:set-badge-count": (_event, count) => { desktopNotifier.setBadgeCount(count) },
  "mako:notification-permission": () => desktopNotifier.permission(),
  "mako:request-notification-permission": () => desktopNotifier.permission(),
  "mako:open-preview-window": async () => { await openWindow({ preview: true }) },
  "mako:quit-client": (event) => {
    if (shutdownAction) {
      BrowserWindow.fromWebContents(event.sender)?.close()
      finishClientShutdown()
    } else if (!closingLocally) {
      void closeClient().catch((error) => {
        closingLocally = false
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send("mako:event", { type: "notice", level: "error", message: error instanceof Error ? error.message : "A draft could not be saved. Mako stayed open." })
      })
    }
  },
}

/** The agent views app's end: no window left to drive for a while, or its host let it go. */
function leaveAgentViews(reason: string): void {
  hostLog("desktop", "agent views app leaving", { pid: process.pid, reason })
  shuttingDown = true
  app.quit()
}

function watchAgentViewsIdle(): void {
  clearTimeout(agentViewsIdle)
  if (role === "agent-views" && agentViews.size === 0)
    agentViewsIdle = setTimeout(() => leaveAgentViews("no window for a minute"), AGENT_VIEWS_IDLE_MS)
}

const devServerUrl = () => process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173"
const isDeskUrl = (url: string) => deskUrlPolicy({ devServerUrl: isDev ? devServerUrl() : null })(url)

/**
 * A window on the host. `preview` keeps its own drafts; `agentView` is a
 * hidden window a host asked for, with that preview id, which agents drive
 * through the host (`desktop-answers-electron.ts`). It keeps painting, never
 * shows, and doesn't hold a profile host awake.
 */
async function openWindow(options: { preview?: boolean; agentView?: string } = {}) {
  if (closingLocally || shutdownAction || shuttingDown) throw new Error("Mako is closing safely. Open another window after it finishes.")
  const id = randomUUID()
  const agentView = options.agentView
  const webPreferences = { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: [`--mako-client=${id}`] }
  const window = agentView
    ? new BrowserWindow({
      title: isDev ? "Mako Dev Agent View" : "Mako Agent View", width: 1600, height: 1000, show: false,
      backgroundColor: DESK_BACKGROUND, enableLargerThanScreen: true,
      // Agents read this window through the protocol; it must keep painting.
      webPreferences: { ...webPreferences, backgroundThrottling: false },
    })
    : new BrowserWindow({
      title: isDev ? "Mako Dev" : "Mako", width: 1440, height: 960, minWidth: 640, minHeight: 540,
      // Painted before the renderer is: a resize or the first frame never flashes white.
      backgroundColor: DESK_BACKGROUND,
      show: false, titleBarStyle: "hiddenInset", trafficLightPosition: { ...DESK_TRAFFIC_LIGHTS },
      webPreferences,
    })
  if (agentView) {
    // macOS clamps a new window to the display; ask for the size again.
    window.setContentSize(1600, 1000)
    agentViews.add(window.webContents.id)
    clearTimeout(agentViewsIdle)
    guardDeskNavigation(window.webContents, isDeskUrl, (url) => hostLog("desktop", "blocked agent view navigation", { url }))
  } else watchRendererHealth(window, { closing: () => shuttingDown || closingLocally || shutdownAction !== null })
  // Shown on the first paint rather than on load: `loadURL` settles on
  // `did-finish-load`, which can precede the first frame, and `--background`
  // keeps test windows hidden until something activates them explicitly.
  let shown = false
  const reveal = () => {
    if (agentView || shown || window.isDestroyed() || app.commandLine.hasSwitch("background")) return
    shown = true
    window.show()
    window.maximize()
  }
  window.once("ready-to-show", reveal)
  let subscription: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let seen = false
  let closed = false
  const waiters = new Set<(connected: boolean) => void>()
  const settle = (connected: boolean) => {
    for (const waiter of waiters) waiter(connected)
    waiters.clear()
  }
  let announced = false
  // Once per outage, whichever notices first: a dropped call or the stream's end.
  const disconnected = () => {
    client.connected = false
    if (announced) return
    announced = true
    if (!closed && !window.isDestroyed()) window.webContents.send("mako:event", { type: "host-disconnected", message: DISCONNECTED_MESSAGE })
  }
  const link: RecoveryLink = {
    // A call dropped before the event stream noticed: tell the window now, and
    // let the stream's own close drive the reconnect as it always has.
    lost: disconnected,
    whenConnected: (timeoutMs) => new Promise((resolve) => {
      if (client.connected) { resolve(true); return }
      if (closed) { resolve(false); return }
      const deadline = setTimeout(() => { waiters.delete(waiter); resolve(false) }, timeoutMs)
      const waiter = (connected: boolean) => { clearTimeout(deadline); resolve(connected) }
      waiters.add(waiter)
    }),
  }
  const client = { id, connected: false, link, dispose() { closed = true; clearTimeout(timer); subscription?.(); settle(false) } }
  const rendererId = window.webContents.id
  clients.set(rendererId, client)
  const connect = () => {
    if (closed || shuttingDown || shutdownAction) return
    subscription?.()
    subscription = subscribeRuntime(runtime.socket, id, (packet) => {
      if (window.isDestroyed()) return
      if (packet.channel === "ready") {
        if (packet.runtime) runtime = { ...runtime, info: packet.runtime }
        client.connected = true
        announced = false
        settle(true)
        if (seen) window.webContents.send("mako:event", { type: "host-reconnected" })
        seen = true
      } else {
        if (packet.payload instanceof Object && "type" in packet.payload) {
          if (packet.payload.type === "app-shutdown") shutdownAction = z.object({ action: z.enum(["quit", "install", "restart"]) }).parse(packet.payload).action
          if (packet.payload.type === "application-lifecycle" && z.object({ lifecycle: z.object({ operation: z.object({ kind: z.literal("error") }) }) }).safeParse(packet.payload).success) shutdownAction = null
          // Event names only: never retain prompts, tool output or arguments.
          breadcrumb(`window=${window.id} event ${String(packet.payload.type)}`)
        }
        window.webContents.send(packet.channel === "event" ? "mako:event" : "mako:terminal-event", packet.payload)
      }
    }, () => {
      disconnected()
      // The agent views app never starts a host; its link ends with this one and it leaves.
      if (closed || window.isDestroyed() || role === "agent-views") return
      const retry = () => {
        if (closed || shuttingDown || shutdownAction) return
        void ensureRuntime(launch).then(async (next) => { runtime = next; await secretKeys?.attached(); connect() }).catch(() => { if (!closed) timer = setTimeout(retry, 2_000) })
      }
      timer = setTimeout(retry, 500)
    }, { history: true, observer: Boolean(agentView) })
  }
  connect()
  window.once("closed", () => { client.dispose(); clients.delete(rendererId); agentViews.delete(rendererId); watchAgentViewsIdle(); finishClientShutdown() })
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: "deny" } })
  if (!agentView) installAutomation(window, isDev)
  const query = new URLSearchParams()
  if (process.env.MAKO_PROFILE) query.set("profile", process.env.MAKO_PROFILE)
  if (options.preview) query.set("preview", id)
  if (agentView) query.set("preview", agentView)
  try {
    if (isDev) {
      const url = new URL(devServerUrl())
      for (const [key, value] of query) url.searchParams.set(key, value)
      await window.loadURL(url.href)
    } else await window.loadURL(deskUrl(Object.fromEntries(query)))
  } catch (error) {
    if (agentView) window.destroy()
    throw error
  }
  reveal()
  return window
}

/** The window in front, for a macOS permission prompt. */
function focusForPermission(): void {
  const window = BrowserWindow.getFocusedWindow() ?? personWindows()[0]
  window?.show()
  window?.focus()
  app.focus({ steal: true })
}

async function start() {
  if (!app.requestSingleInstanceLock()) { app.exit(0); return }
  if (role === "agent-views") return startAgentViews()
  app.on("second-instance", () => { if (runtime) void openWindow() })
  runtime = await ensureRuntime(launch)
  if (!isDev) {
    const target = join(uiRoot, "Local Storage")
    const exists = await access(target).then(() => true, () => false)
    if (!exists) {
      await mkdir(uiRoot, { recursive: true })
      const staging = await mkdtemp(join(uiRoot, ".storage-migration-"))
      try {
        await cp(join(dataRoot, "Local Storage"), join(staging, "Local Storage"), { recursive: true, errorOnExist: true, force: false })
        await rename(join(staging, "Local Storage"), target)
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      } finally { await rm(staging, { recursive: true, force: true }) }
    }
  }
  await app.whenReady()
  closeOnSignals()
  // Before any window reads a secret: the host runs as Node and has no `safeStorage` of its own.
  secretKeys = new SecretKeyLink(runtime.socket, dataKeyPath(userRootFor({ dataRoot, appData: app.getPath("appData"), home: homedir() })), electronSecretEncryption())
  await secretKeys.attached()
  const updater = desktopUpdates({
    version: app.getVersion(),
    supported: app.isPackaged && packagedDistribution(app.getAppPath()) === "signed",
    quitting: () => { shuttingDown = true },
    changed: (state) => desktopLink?.frame({ kind: "update", state }),
  })
  updates = updater
  powerMonitor.on("shutdown", () => { shuttingDown = true })
  // The host also notices sleep from its clock; these make the wake immediate and add the screen unlock.
  /** The desktop process's own calls, which belong to no window. */
  const desktopClient = randomUUID()
  const woke = (source: "resume" | "unlock-screen") => () => {
    void invokeRuntime(runtime.socket, desktopClient, "mako:machine-woke", [source]).catch((error) =>
      hostLog("desktop", "wake not delivered", { source, reason: error instanceof Error ? error.message : String(error) }))
  }
  powerMonitor.on("resume", woke("resume"))
  powerMonitor.on("unlock-screen", woke("unlock-screen"))
  await serveWindows()
  // What only this process can do for the host: Mako.app's grants, window capture, agents' windows and its own update.
  const pages = deskPageAnswers({ agentView: (previewId) => openWindow({ agentView: previewId }), frame: (frame) => desktopLink?.frame(frame) })
  desktopLink = new DesktopLink({
    socket: () => runtime.socket,
    role,
    handlers: {
      ...machineAnswers(focusForPermission),
      ...pages.handlers,
      "update-check": () => updater.check(),
      "update-install": async () => { updater.install(); return null },
    },
    attached: () => desktopLink?.frame({ kind: "update", state: updater.state() }),
    detached: pages.forget,
  })
  desktopLink.start()
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Mako", submenu: [{ role: "about" }, { label: "Updates…", click: () => requestCommand("app.updates") }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]))
  await openWindow()
  app.on("activate", () => { if (!personWindows().length) void openWindow() })
}

/** The agent views app: windows for the host that started it, while it's there, and nothing for a person. */
async function startAgentViews() {
  app.dock?.hide()
  const location = runtimeLocation(dataRoot)
  const probe = await settleRuntime(location.socket)
  if (probe.state !== "ready") {
    hostLog("desktop", "agent views app leaving", { pid: process.pid, reason: "its host is gone" })
    app.exit(0)
    return
  }
  runtime = { ...location, info: probe.info }
  await app.whenReady()
  closeOnSignals()
  await serveWindows()
  const pages = deskPageAnswers({ agentView: (previewId) => openWindow({ agentView: previewId }), frame: (frame) => desktopLink?.frame(frame) })
  desktopLink = new DesktopLink({
    socket: () => runtime.socket,
    role,
    handlers: pages.handlers,
    detached: pages.forget,
    finished: () => leaveAgentViews("its host let it go"),
  })
  desktopLink.start()
  watchAgentViewsIdle()
}

/** What every window of this process is served: the host's files, and its calls through the socket. */
async function serveWindows() {
  protocol.handle("mako-file", (request) => runtimeFile(runtime.socket, request))
  if (!isDev) {
    serveDesk(rendererBundle, (request) => runtimeFile(runtime.socket, request))
    const moved = await adoptDeskOrigin({ userData: uiRoot, dist: rendererBundle })
    if (moved.kind === "failed") console.warn(`[mako-client] renderer storage move failed: ${moved.error}`)
  }
  for (const channel of hostChannels) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      // A window is a page: a fixture desk refuses it what it refuses a page in a browser, before its arguments are read (`fixture-desk-policy.ts`).
      const refusal = runtime.info.fixture ? fixtureDeskRefusal(channel) : undefined
      if (refusal) throw new FixtureDeskRefusedError(refusal)
      const args = hostCallInput(channel).parse(raw)
      const client = clients.get(event.sender.id)
      if (!client) throw new Error("This Mako client has closed")
      breadcrumb(`renderer=${event.sender.id} invoke ${channel}`)
      // Reporting must work even when the shared host is unavailable.
      if (channel === "mako:report-crash") {
        const [kind, payload] = hostCallInput("mako:report-crash").parse(args)
        const error = new Error(payload.message)
        error.stack = payload.stack
        record(kind, error, `renderer=${event.sender.id} ${payload.source ?? ""}`)
        return
      }
      if (channel === "mako:crashes") return listCrashes()
      if (channel === "mako:crashes-dir") return crashesDir()
      if (channel === "mako:clear-crashes") return clearCrashes()
      if (channel === "mako:shutdown-ack" && draftShutdown.acknowledge(z.string().parse(args[0]), String(event.sender.id))) return
      if (isClientCall(channel)) return answerClientCall(clientAnswers, channel, event, hostCallInput(channel).parse(raw))
      if (channel === "mako:pick-folder") {
        const parent = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] }
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : result.filePaths[0]
      }
      if (!runtime.info.methods.includes(channel)) throw new Error("This action requires a newer shared host. Existing agents have not been restarted.")
      if (channel === "mako:control-preview")
        return invokeWithRecovery(channel, () => invokeRuntimePreview(runtime.socket, client.id, runtime.info.previewSizing ? args : args.slice(0, 3)), client.link)
      const correlationId = randomUUID()
      const result = await invokeWithRecovery(channel, (attempt) => invokeRuntime(runtime.socket, client.id, channel, args, attempt, { history: true, correlationId }), client.link)
      if (channel === "mako:boot") {
        if (pendingCommand) { event.sender.send("mako:event", { type: "app-command", command: pendingCommand }); pendingCommand = null }
        const boot = z.object({ machine: MachineOfferSchema.optional() }).catchall(z.json()).parse(result)
        // This app answers the folder chooser with its own dialog, whatever the host's machine offers.
        const machine: MachineOffer = { ...(boot.machine ?? UNSTATED_MACHINE_OFFER), chooseFolder: true }
        return { ...boot, machine, sourceRoot: isDev ? app.getAppPath() : undefined }
      }
      return result
    })
  }
}

app.on("before-quit", (event) => {
  // A quit the system asks the agent views app for needs no window's answer.
  if (!shuttingDown && role === "desktop") {
    event.preventDefault()
    requestCommand("app.quit")
    return
  }
  desktopNotifier.dispose()
  secretKeys?.dispose()
  updates?.dispose()
  desktopLink?.dispose()
  for (const client of clients.values()) client.dispose()
})
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit() })
app.on("will-quit", () => {
  hostLog("desktop", "quitting", { pid: process.pid, action: shutdownAction ?? "client" })
  void flushHostLog()
})
void start().catch(async (error) => {
  record("main-rejection", error, "startup")
  await flushHostLog()
  // Nobody is looking at the agent views app; the host tells the agent that asked.
  if (role === "agent-views") app.exit(1)
  await app.whenReady()
  dialog.showErrorBox("Mako could not attach to its shared host", error instanceof Error ? error.message : "Shared host startup failed")
  app.exit(1)
})
