import { desktopCapturer } from "electron"
import type { WindowCapturer } from "./appshots.js"

const windowIdOf = (source: Electron.DesktopCapturerSource) => Number(source.id.split(":")[1])

/** Electron's `desktopCapturer`, for app shots' pictures and live previews. */
export const electronWindowCapturer: WindowCapturer = {
  async windows() {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    })
    return sources.map((source) => ({
      windowId: windowIdOf(source),
      name: source.name,
      ...(!source.thumbnail.isEmpty() && {
        thumbnail: { mimeType: "image/jpeg", data: source.thumbnail.resize({ width: 320 }).toJPEG(65).toString("base64") },
      }),
      ...(source.appIcon && !source.appIcon.isEmpty() && {
        icon: { mimeType: "image/png", data: source.appIcon.resize({ width: 24, height: 24 }).toPNG().toString("base64") },
      }),
    }))
  },
  async source(windowId) {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    })
    return sources.find((source) => windowIdOf(source) === windowId)?.id ?? null
  },
}
