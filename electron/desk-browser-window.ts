import { BrowserWindow } from "electron"
import { z } from "zod"
import type { DeskPage } from "@mako/host/control/desk-browser"

const jsonObject = z.record(z.string(), z.json())
const pdfOptions = z.object({
  landscape: z.boolean().default(false),
  printBackground: z.boolean().default(true),
  scale: z.number().default(1),
  pageRanges: z.string().optional(),
  paperWidth: z.number().optional(),
  paperHeight: z.number().optional(),
})

/**
 * Adapt a hidden BrowserWindow to the desk browser's page contract. The
 * window's debugger is Chrome's protocol for that renderer; events and
 * results are passed through unchanged apart from JSON validation.
 */
export function deskPageForWindow(window: BrowserWindow): DeskPage {
  const contents = window.webContents
  const debug = contents.debugger
  if (!debug.isAttached()) debug.attach("1.3")
  return {
    id: `desk-${contents.id}`,
    url: () => contents.getURL(),
    title: () => contents.getTitle(),
    async send(method, params) {
      // Electron's debugger lacks Page.printToPDF; its own printer covers it.
      if (method === "Page.printToPDF") {
        const options = pdfOptions.parse(params)
        const buffer = await contents.printToPDF({
          landscape: options.landscape,
          printBackground: options.printBackground,
          scale: options.scale,
          pageRanges: options.pageRanges,
          pageSize:
            options.paperWidth !== undefined &&
            options.paperHeight !== undefined
              ? { width: options.paperWidth, height: options.paperHeight }
              : "Letter",
        })
        return { data: buffer.toString("base64") }
      }
      const result: unknown = await debug.sendCommand(method, params)
      return jsonObject.safeParse(result).data ?? {}
    },
    onMessage(listener) {
      let active = true
      debug.on("message", (_event, method, params) => {
        if (active) listener(method, jsonObject.safeParse(params).data ?? {})
      })
      return () => {
        active = false
      }
    },
    onDestroyed(listener) {
      window.once("closed", listener)
      return () => {
        window.removeListener("closed", listener)
      }
    },
    destroy() {
      if (!window.isDestroyed()) window.destroy()
    },
  }
}
