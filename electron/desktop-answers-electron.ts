import type { BrowserWindow } from "electron"
import { computerPermissions, requestComputerPermissions } from "./computer-permissions.js"
import { electronPrivacy } from "./computer-permissions-electron.js"
import type { DesktopFrame } from "./contracts/desktop-channel.js"
import type { DeskPage } from "./desk-browser.js"
import { deskPageForWindow } from "./desk-browser-window.js"
import type { DesktopHandlers } from "./desktop-link.js"
import { electronWindowCapturer } from "./window-capture-electron.js"

export interface DeskPageAnswersInput {
  /** A hidden window on the desk for agents to drive, already loading its preview. */
  agentView(previewId: string): Promise<BrowserWindow>
  /** A frame for the host about a window it drives. */
  frame(frame: DesktopFrame): void
}

export interface DeskPageAnswers {
  handlers: DesktopHandlers
  /** Close the windows made for a host that went away; it no longer drives them. */
  forget(): void
}

/** The hidden desk windows agents drive, which the desktop and the agent views app both make (`desktop-link.ts`). */
export function deskPageAnswers({ agentView, frame }: DeskPageAnswersInput): DeskPageAnswers {
  const pages = new Map<string, DeskPage>()
  return {
    handlers: {
      "desk-page-create": async ({ previewId }) => {
        const window = await agentView(previewId)
        const page = deskPageForWindow(window)
        pages.set(page.id, page)
        page.onMessage((method, params) => frame({ kind: "page", page: page.id, message: { method, params } }))
        const state = () => frame({ kind: "page", page: page.id, state: { url: page.url(), title: page.title() } })
        window.webContents.on("did-navigate", state)
        window.webContents.on("did-navigate-in-page", state)
        window.webContents.on("page-title-updated", state)
        page.onDestroyed(() => {
          pages.delete(page.id)
          frame({ kind: "page", page: page.id, destroyed: true })
        })
        return { page: page.id, url: page.url(), title: page.title() }
      },
      "desk-page-send": ({ page, method, params }) => {
        const target = pages.get(page)
        if (!target) return Promise.reject(new Error("That window closed."))
        return target.send(method, params)
      },
      "desk-page-destroy": async ({ page }) => {
        pages.get(page)?.destroy()
        return null
      },
    },
    forget: () => {
      for (const page of pages.values()) page.destroy()
      pages.clear()
    },
  }
}

/** What only the desktop app the person opened can answer about their Mac: Mako.app's grants and the windows on its screen. */
export function machineAnswers(focus: () => void): DesktopHandlers {
  return {
    "computer-permissions": async () => computerPermissions(electronPrivacy),
    "computer-permissions-request": () => requestComputerPermissions(electronPrivacy, focus),
    "window-thumbnails": () => electronWindowCapturer.windows(),
    "window-source": ({ windowId }) => electronWindowCapturer.source(windowId),
  }
}
