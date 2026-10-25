import { dialog, type BrowserWindow } from "electron"
import type { CrashReports } from "@mako/host/base/crash"
import { hostLog, hostWarn } from "@mako/host/base/host-log"

/** Only a dead renderer is reloaded. A slow, still-live renderer may hold drafts. */
export function watchRendererHealth(
  window: BrowserWindow,
  crashes: CrashReports,
  options: {
    closing: () => boolean
    retry?: () => Promise<boolean>
  }
): void {
  const contents = window.webContents
  const source = `window=${window.id} renderer=${contents.id}`
  let lastRecovery = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let deciding = false
  const available = () => !window.isDestroyed() && !contents.isDestroyed() && !options.closing()
  const reload = () => {
    if (!available()) return
    lastRecovery = Date.now()
    hostWarn("renderer", "reloading after crash", { window: window.id })
    contents.reload()
  }
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return
    crashes.record("renderer-gone", new Error(`renderer exited: ${details.reason} (exit ${details.exitCode})`), source)
    clearTimeout(timer)
    if (!available() || deciding) return
    if (Date.now() - lastRecovery >= 60_000) {
      timer = setTimeout(reload, 400)
      return
    }
    // An immediate second crash needs a deliberate retry, not a reload loop.
    deciding = true
    const retry = options.retry ?? (async () => {
      const result = await dialog.showMessageBox(window, {
        type: "error",
        message: "This window crashed again",
        detail: `Mako stopped reloading this window. Reloading does not restart your agents. Local reports are in ${crashes.directory}.`,
        buttons: ["Keep window open", "Reload window"],
        defaultId: 0,
        cancelId: 0,
      })
      return result.response === 1
    })
    void retry().then((again) => { if (again) reload() }).catch((error) => {
      crashes.record("main-rejection", error, `${source} recovery`)
    }).finally(() => { deciding = false })
  })
  contents.on("preload-error", (_event, _path, error) => crashes.record("renderer-error", error, `${source} preload`))
  contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return // ERR_ABORTED is an interrupted navigation.
    crashes.record("renderer-error", new Error(`Page load failed: ${description} (${code})`), source)
  })
  contents.on("did-finish-load", () => {
    crashes.breadcrumb(`${source} loaded`)
    hostLog("renderer", "loaded", { window: window.id, pid: contents.getOSProcessId() })
  })
  window.on("unresponsive", () => {
    crashes.breadcrumb(`${source} unresponsive`)
    hostWarn("renderer", "unresponsive", { window: window.id, pid: contents.getOSProcessId() })
  })
  window.on("responsive", () => hostLog("renderer", "responsive", { window: window.id }))
  // The window's own warnings and errors land beside the host's lines, so a window stuck asking for something is seen
  // from its side too. Each message is said at most once a minute.
  const said = new Map<string, number>()
  contents.on("console-message", (event) => {
    if (event.level !== "warning" && event.level !== "error") return
    const message = event.message.slice(0, 600)
    const now = Date.now()
    if (now - (said.get(message) ?? -Infinity) < 60_000) return
    said.set(message, now)
    if (said.size > 256) said.delete(said.keys().next().value!)
    hostWarn("renderer", event.level === "error" ? "console error" : "console warning", { window: window.id, message, source: `${event.sourceId.split("/").at(-1)}:${event.lineNumber}` })
  })
  window.once("closed", () => {
    clearTimeout(timer)
    crashes.breadcrumb(`${source} closed`)
    hostLog("renderer", "closed", { window: window.id })
  })
}
