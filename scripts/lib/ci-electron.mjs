import { downloadArtifact } from "@electron/get"
import { setTimeout } from "node:timers/promises"
import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { releaseResponse, transientDownloadError } from "./release-download.mjs"

/** Retry the release download, leaving checksum errors and permanent HTTP failures fatal. */
export async function downloadElectron(details) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadArtifact({
        ...details,
        // Keep the original URL as @electron/get's cache key: Electron's installer reads that same key.
        downloader: { async download(url, file, options) {
          const response = await releaseResponse(url, options)
          if (!response.body) throw new Error("Release response has no body")
          await mkdir(dirname(file), { recursive: true })
          await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
        } },
        downloadOptions: { ...details.downloadOptions, signal: AbortSignal.timeout(120_000) },
      })
    } catch (error) {
      const status = error.status ?? error.response?.status
      if (!transientDownloadError(error) || attempt === 4) throw error
      const delay = 1_000 * 2 ** attempt
      console.warn(`Electron download failed (${status ? `HTTP ${status}` : error.name}); retrying in ${delay / 1_000}s (${attempt + 2}/5)`)
      await setTimeout(delay)
    }
  }
}
