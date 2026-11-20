import { contextBridge, ipcRenderer } from "electron"
// Types alone: the contract's schemas are values, and bundling them would put zod into the page's preload.
import type { LIVE_VIDEO_CHANNEL, LiveVideoPageAsk, LiveVideoPageEvent } from "@mako/host/contracts/live-video"

const CHANNEL: typeof LIVE_VIDEO_CHANNEL = "mako:live-video"

/** The live video page's one way to the main process (`src/live-video/page.ts`, `live-video-electron.ts`). */
contextBridge.exposeInMainWorld("makoLiveVideo", {
  send: (event: LiveVideoPageEvent) => ipcRenderer.send(CHANNEL, event),
  listen: (handler: (ask: LiveVideoPageAsk) => void) => {
    ipcRenderer.on(CHANNEL, (_event, ask: LiveVideoPageAsk) => handler(ask))
  },
})
