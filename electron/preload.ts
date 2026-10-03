import { contextBridge, ipcRenderer, webUtils } from "electron"
// The bridge alone, not `shared.js`: that barrel's contract schemas are
// values, and bundling them would put all of zod into every renderer's preload.
import { createMakoBridge } from "./contracts/renderer-bridge.js"
import type { HostEvent, TerminalEvent } from "./shared.js"
import { resolveDeskPreviewUrl } from "./desk-preview-url.js"

// Sandboxed Electron preloads have Chromium's location even though this
// compiler project uses Node libraries rather than the full DOM library.
declare const location: { readonly href: string }

const clientId = process.argv.find((argument) => argument.startsWith("--mako-client="))?.slice("--mako-client=".length)
const api = createMakoBridge({
  nativeWindowVideo: true,
  // Electron owns and types this trusted local transport's return value.
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, payload: HostEvent) =>
      listener(payload)
    ipcRenderer.on("mako:event", receive)
    return () => {
      ipcRenderer.removeListener("mako:event", receive)
    }
  },
  onTerminalEvent: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent
    ) => listener(payload)
    ipcRenderer.on("mako:terminal-event", receive)
    return () => {
      ipcRenderer.removeListener("mako:terminal-event", receive)
    }
  },
  resolveFileUrl: (url) => {
    return resolveDeskPreviewUrl(url, location.href, clientId)
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
})
contextBridge.exposeInMainWorld("mako", api)
