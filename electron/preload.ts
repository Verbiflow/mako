import { contextBridge, ipcRenderer, webUtils } from "electron"
// The bridge alone: the other contracts' schemas are values, and bundling
// them would put all of zod into every renderer's preload.
import { createMakoBridge } from "@mako/host/contracts/renderer-bridge"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { TerminalEvent } from "@mako/host/contracts/terminal"
import { resolveDeskPreviewUrl } from "@mako/host/contracts/desk-url"
import { answerCrossesEncoded, decodeRuntimeEvent, decodeRuntimeValue } from "@mako/host/contracts/runtime-value"

// Sandboxed Electron preloads have Chromium's location even though this
// compiler project uses Node libraries rather than the full DOM library.
declare const location: { readonly href: string }

const clientId = process.argv.find((argument) => argument.startsWith("--mako-client="))?.slice("--mako-client=".length)
const api = createMakoBridge({
  nativeWindowVideo: true,
  // Main sends each answer as the host encoded it (`answerCrossesEncoded`); this decodes it, once.
  invoke: async (channel, ...args) => {
    const answer = await ipcRenderer.invoke(channel, ...args)
    return answerCrossesEncoded(channel) ? decodeRuntimeValue(answer) : answer
  },
  // Events cross as their producer's JSON text too; this decodes each once.
  onEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, payload: string) =>
      listener(decodeRuntimeEvent<HostEvent>(payload))
    ipcRenderer.on("mako:event", receive)
    return () => {
      ipcRenderer.removeListener("mako:event", receive)
    }
  },
  onTerminalEvent: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      payload: string
    ) => listener(decodeRuntimeEvent<TerminalEvent>(payload))
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
