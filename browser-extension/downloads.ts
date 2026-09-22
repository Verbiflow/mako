import type { ExtensionCommand } from "../electron/browser-extension-protocol.js"
import { z } from "zod"
const requestSchema = z.object({
  url: z.url().refine((url) => /^https?:/.test(url)),
  timeoutMs: z.number().int().min(0).max(300000).default(60000),
})
interface DownloadOwner {
  client: string
  targetId: string
}
interface OwnedDownload extends DownloadOwner {
  finished: boolean
}

/** Browser-issued IDs identify our downloads; page URLs and filenames never do. */
export class ExtensionDownloads {
  private readonly owned = new Map<number, OwnedDownload>()
  constructor(private readonly api: Pick<typeof chrome, "downloads">) {}
  async start(owner: DownloadOwner, params: ExtensionCommand["params"]) {
    const request = requestSchema.parse(params)
    if (this.owned.size >= 128) {
      const oldest = [...this.owned].find(([, record]) => record.finished)
      if (oldest) this.owned.delete(oldest[0])
      else
        throw new Error(
          "Wait for an active download to finish before starting another."
        )
    }
    const id = await this.api.downloads.download({
      url: request.url,
      saveAs: false,
      conflictAction: "uniquify",
    })
    this.owned.set(id, { ...owner, finished: false })
    return this.status(owner, id, request.timeoutMs)
  }
  async status(owner: DownloadOwner, id: number, timeoutMs: number) {
    const record = this.owned.get(id)
    if (
      !record ||
      record.client !== owner.client ||
      record.targetId !== owner.targetId
    )
      throw new Error("This download does not belong to the exact task tab")
    const deadline = Date.now() + timeoutMs
    while (true) {
      // Subscribe before reading so completion between read and wait is not lost.
      let wake: () => void = () => {}
      const changed = new Promise<void>((resolve) => {
        wake = resolve
      })
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id === id) wake()
      }
      this.api.downloads.onChanged.addListener(listener)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const item = (await this.api.downloads.search({ id }))[0]
        if (!item) throw new Error("The browser no longer has this download")
        if (item.state !== "in_progress" || Date.now() >= deadline) {
          record.finished = item.state !== "in_progress"
          return {
            id: item.id,
            state:
              item.state === "complete"
                ? "completed"
                : item.state === "interrupted"
                  ? "canceled"
                  : "inProgress",
            url: item.finalUrl || item.url,
            path:
              item.state === "complete" && item.exists ? item.filename : null,
            bytes: item.bytesReceived,
            error: item.error ?? null,
          }
        }
        timer = setTimeout(wake, Math.max(1, deadline - Date.now()))
        await changed
      } finally {
        if (timer) clearTimeout(timer)
        this.api.downloads.onChanged.removeListener(listener)
      }
    }
  }
  release(client: string) {
    for (const [id, owner] of this.owned)
      if (owner.client === client) this.owned.delete(id)
  }
}
