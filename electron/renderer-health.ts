import { dialog, type BrowserWindow } from "electron"
import { breadcrumb, crashesDir, record } from "./crash.js"
import { hostLog, hostWarn } from "./host-log.js"

/** Only a dead renderer is reloaded. A slow, still-live renderer may hold drafts. */
export function watchRendererHealth(
  window: BrowserWindow,
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
    record("renderer-gone", new Error(`renderer exited: ${details.reason} (exit ${details.exitCode})`), source)
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
        detail: `Mako stopped reloading this window. Reloading does not restart your agents. Local reports are in ${crashesDir()}.`,
        buttons: ["Keep window open", "Reload window"],
        defaultId: 0,
        cancelId: 0,
      })
      return result.response === 1
    })
    void retry().then((again) => { if (again) reload() }).catch((error) => {
      record("main-rejection", error, `${source} recovery`)
    }).finally(() => { deciding = false })
  })
  contents.on("preload-error", (_event, _path, error) => record("renderer-error", error, `${source} preload`))
  contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return // ERR_ABORTED is an interrupted navigation.
    record("renderer-error", new Error(`Page load failed: ${description} (${code})`), source)
  })
  contents.on("did-finish-load", () => {
    breadcrumb(`${source} loaded`)
    hostLog("renderer", "loaded", { window: window.id, pid: contents.getOSProcessId() })
  })
  window.on("unresponsive", () => {
    breadcrumb(`${source} unresponsive`)
    hostWarn("renderer", "unresponsive", { window: window.id, pid: contents.getOSProcessId() })
  })
  window.on("responsive", () => hostLog("renderer", "responsive", { window: window.id }))
  window.once("closed", () => {
    clearTimeout(timer)
    breadcrumb(`${source} closed`)
    hostLog("renderer", "closed", { window: window.id })
  })
}
