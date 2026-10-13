import { getMako } from "@/lib/bridge"
import type { AttachmentInput } from "@/lib/attachments"
import type { Appshot, AppshotTarget, AppshotWindow } from "@/lib/types"

/** At most this much of a window's title goes in its chip; the item keeps all of it. */
const LABEL_LENGTH = 56

/** A capture's chip words: the app, then the window's title. */
export function appshotLabel(window: Pick<AppshotWindow, "app" | "title">): string {
  const title = window.title.replace(/\s+/g, " ").trim()
  const label = title && title !== window.app ? `${window.app} — ${title}` : window.app
  return label.length > LABEL_LENGTH ? `${label.slice(0, LABEL_LENGTH - 1).trimEnd()}…` : label
}

function fileName(window: Pick<AppshotWindow, "app" | "title">, extension: string): string {
  const safe = appshotLabel(window).replace(/[/\\:*?"<>|\n]/g, "-").replace(/…$/, "")
  return `${safe || "Window"}.${extension}`
}

function bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

/**
 * A capture as the record the composer stages: the picture as the file, the
 * window's elements (`window-outline.ts`) as its context, staged beside it
 * and carried in the item, and whose window it was for the tile and chip.
 */
export function appshotAttachment(shot: Appshot): AttachmentInput {
  const png = shot.image.mimeType === "image/png"
  const icon = shot.window.icon ? `data:${shot.window.icon.mimeType};base64,${shot.window.icon.data}` : undefined
  return {
    file: new File([bytes(shot.image.data)], fileName(shot.window, png ? "png" : "jpg"), { type: shot.image.mimeType }),
    context: shot.text,
    contextLabel: appshotLabel(shot.window),
    origin: "window",
    window: { app: shot.window.app, title: shot.window.title, ...(icon && { icon }) },
  }
}

export const appshots = {
  windows: () => getMako().appshotWindows(),
  frontWindow: (exclude: number[], front?: number) => getMako().appshotFrontWindow({ exclude, ...(front !== undefined && { front }) }),
  /** The picture and the elements of one window, read through the host's driver. */
  read: (target: AppshotTarget) => getMako().captureAppshot(target),
  async capture(target: AppshotTarget): Promise<AttachmentInput[]> {
    return [appshotAttachment(await getMako().captureAppshot(target))]
  },
}
