import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, powerMonitor, protocol, shell } from "electron"
import { WindowShutdown } from "./window-shutdown.js"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, access, mkdtemp, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { hostCallInputs } from "./contracts/host-call-inputs.js"
import { ensureRuntime, runtimeDataRoot } from "./runtime-service.js"
import { invokeRuntime, runtimeFile, subscribeRuntime } from "./runtime-connection.js"
import { invokeWithRecovery, type RecoveryLink } from "./runtime-retry.js"
import { HOST_OUTAGE_MESSAGE } from "./contracts/host-connection.js"
import { electronDesktopNotifier, surfaceWindow } from "./desktop-notifications-electron.js"
import { DESK_BACKGROUND, DESK_TRAFFIC_LIGHTS, deskUrl, privilegedSchemes } from "./desk-scheme.js"
import { serveDesk } from "./desk-protocol.js"
import { adoptDeskOrigin } from "./renderer-storage.js"
import { breadcrumb, clearCrashes, crashesDir, installCrashReporting, listCrashes, record } from "./crash.js"
import { flushHostLog, hostLog, installHostLog } from "./host-log.js"
import { watchRendererHealth } from "./renderer-health.js"
import { buildIdentity } from "./build-identity.js"

const directory = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && !process.env.MAKO_PROD
const dataRoot = runtimeDataRoot(app.getPath("appData"), process.env)
const flavor = process.env.MAKO_CLIENT_ID ?? (isDev ? `dev-${createHash("sha256").update(app.getAppPath()).digest("hex").slice(0, 12)}` : "desktop")
if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(flavor)) throw new Error("Invalid Mako client identity")
const uiRoot = `${dataRoot}-ui-${flavor}`
app.setPath("userData", uiRoot)
installHostLog(join(uiRoot, "logs", "desktop.log"))
installCrashReporting({ directory: join(dataRoot, "crashes"), source: `desktop pid=${process.pid}` })
hostLog("desktop", "starting", { pid: process.pid, build: buildIdentity()?.id, version: app.getVersion(), dataRoot, uiRoot })
protocol.registerSchemesAsPrivileged(privilegedSchemes())
const rendererBundle = join(directory, "../dist")

const launch = { dataRoot, executable: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()], cwd: process.cwd(), env: process.env }
const clients = new Map<number, { id: string; connected: boolean; link: RecoveryLink; dispose(): void }>()
const DISCONNECTED_MESSAGE = HOST_OUTAGE_MESSAGE
let runtime: Awaited<ReturnType<typeof ensureRuntime>>
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
    const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === windowId) ?? BrowserWindow.getAllWindows()[0]
    if (!target || target.isDestroyed()) return
    surfaceWindow(target)
    target.webContents.send("mako:event", { type: "notification-activated", ...activation })
  },
})

function requestCommand(command: "app.quit" | "app.updates"): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (window && !window.webContents.isLoadingMainFrame()) { window.show(); window.webContents.send("mako:event", { type: "app-command", command }) }
  else {
    pendingCommand = command
    if (!window) void openWindow().catch((error) => dialog.showErrorBox("Mako could not open", error instanceof Error ? error.message : "Try opening Mako again."))
  }
}

function finishClientShutdown(): void {
  if (!shutdownAction || shuttingDown || BrowserWindow.getAllWindows().length) return
  shuttingDown = true
  if (shutdownAction === "restart") app.relaunch()
  app.quit()
}

async function openWindow(preview = false) {
  if (closingLocally || shutdownAction || shuttingDown) throw new Error("Mako is closing safely. Open another window after it finishes.")
  const id = randomUUID()
  const window = new BrowserWindow({
    title: isDev ? "Mako Dev" : "Mako", width: 1440, height: 960, minWidth: 640, minHeight: 540,
    // Painted before the renderer is: a resize or the first frame never flashes white.
    backgroundColor: DESK_BACKGROUND,
    show: false, titleBarStyle: "hiddenInset", trafficLightPosition: { ...DESK_TRAFFIC_LIGHTS },
    webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: [`--mako-client=${id}`] },
  })
  watchRendererHealth(window, { closing: () => shuttingDown || closingLocally || shutdownAction !== null })
  // Shown on the first paint rather than on load: `loadURL` settles on
  // `did-finish-load`, which can precede the first frame, and `--background`
  // keeps test windows hidden until something activates them explicitly.
  let shown = false
  const reveal = () => {
    if (shown || window.isDestroyed() || app.commandLine.hasSwitch("background")) return
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
      if (closed || window.isDestroyed()) return
      const retry = () => {
        if (closed || shuttingDown || shutdownAction) return
        void ensureRuntime(launch).then((next) => { runtime = next; connect() }).catch(() => { if (!closed) timer = setTimeout(retry, 2_000) })
      }
      timer = setTimeout(retry, 500)
    }, { history: true })
  }
  connect()
  window.once("closed", () => { client.dispose(); clients.delete(rendererId); finishClientShutdown() })
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: "deny" } })
  const query = new URLSearchParams({ runtime: "shared" })
  if (process.env.MAKO_PROFILE) query.set("profile", process.env.MAKO_PROFILE)
  if (preview) query.set("preview", id)
  if (isDev) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173")
    for (const [key, value] of query) url.searchParams.set(key, value)
    await window.loadURL(url.href)
  } else await window.loadURL(deskUrl(Object.fromEntries(query)))
  reveal()
  return window
}

async function start() {
  if (!app.requestSingleInstanceLock()) { app.exit(0); return }
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
  powerMonitor.on("shutdown", () => { shuttingDown = true })
  protocol.handle("mako-file", (request) => runtimeFile(runtime.socket, request))
  if (!isDev) {
    serveDesk(rendererBundle)
    const moved = await adoptDeskOrigin({ userData: uiRoot, dist: rendererBundle })
    if (moved.kind === "failed") console.warn(`[mako-client] renderer storage move failed: ${moved.error}`)
  }
  for (const [channel, schema] of Object.entries(hostCallInputs)) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      const args = schema.parse(raw)
      const client = clients.get(event.sender.id)
      if (!client) throw new Error("This Mako client has closed")
      breadcrumb(`renderer=${event.sender.id} invoke ${channel}`)
      // Reporting must work even when the shared host is unavailable.
      if (channel === "mako:report-crash") {
        const [kind, payload] = hostCallInputs["mako:report-crash"].parse(args)
        const error = new Error(payload.message)
        error.stack = payload.stack
        record(kind, error, `renderer=${event.sender.id} ${payload.source ?? ""}`)
        return
      }
      if (channel === "mako:crashes") return listCrashes()
      if (channel === "mako:crashes-dir") return crashesDir()
      if (channel === "mako:clear-crashes") return clearCrashes()
      if (channel === "mako:shutdown-ack" && draftShutdown.acknowledge(z.string().parse(args[0]), String(event.sender.id))) return
      if (channel === "mako:quit-client") {
        if (shutdownAction) {
          BrowserWindow.fromWebContents(event.sender)?.close()
          finishClientShutdown()
        } else if (!closingLocally) {
          closingLocally = true
          void draftShutdown.request([...clients.keys()].map(String), (requestId) => {
            for (const window of BrowserWindow.getAllWindows()) window.webContents.send("mako:event", { type: "app-shutdown", requestId, action: "quit" })
          }).then(() => { shuttingDown = true; app.quit() }).catch((error) => {
            closingLocally = false
            for (const window of BrowserWindow.getAllWindows()) window.webContents.send("mako:event", { type: "notice", level: "error", message: error instanceof Error ? error.message : "A draft could not be saved. Mako stayed open." })
          })
        }
        return
      }
      if (channel === "mako:open-preview-window") { await openWindow(true); return }
      if (channel === "mako:copy") { clipboard.writeText(z.string().parse(args[0])); return }
      if (channel === "mako:open-url") {
        const url = z.url({ protocol: /^https?$/ }).parse(args[0])
        await shell.openExternal(url)
        return
      }
      if (channel === "mako:notify") return desktopNotifier.notify(event.sender.id, hostCallInputs["mako:notify"].parse(args)[0])
      if (channel === "mako:notify-dismiss") { desktopNotifier.dismiss(z.string().parse(args[0])); return }
      if (channel === "mako:set-badge-count") { desktopNotifier.setBadgeCount(z.number().parse(args[0])); return }
      if (channel === "mako:notification-permission" || channel === "mako:request-notification-permission") return desktopNotifier.permission()
      if (channel === "mako:pick-folder") {
        const parent = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] }
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : result.filePaths[0]
      }
      if (!runtime.info.methods.includes(channel)) throw new Error("This action requires a newer shared host. Existing agents have not been restarted.")
      const result = await invokeWithRecovery(channel, (attempt) => invokeRuntime(runtime.socket, client.id, channel, args, attempt, { history: true }), client.link)
      if (channel === "mako:boot") {
        if (pendingCommand) { event.sender.send("mako:event", { type: "app-command", command: pendingCommand }); pendingCommand = null }
        return { ...z.record(z.string(), z.json()).parse(result), sourceRoot: isDev ? app.getAppPath() : undefined }
      }
      return result
    })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Mako", submenu: [{ role: "about" }, { label: "Updates…", click: () => requestCommand("app.updates") }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]))
  await openWindow()
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void openWindow() })
}

app.on("before-quit", (event) => {
  if (!shuttingDown) {
    event.preventDefault()
    requestCommand("app.quit")
    return
  }
  desktopNotifier.dispose()
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
  await app.whenReady()
  dialog.showErrorBox("Mako could not attach to its shared host", error instanceof Error ? error.message : "Shared host startup failed")
  app.exit(1)
})
