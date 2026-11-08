import { downloadArtifact } from "@electron/get"
import { setTimeout } from "node:timers/promises"

/** Retry the release download, leaving checksum errors and permanent HTTP failures fatal. */
export async function downloadElectron(details) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadArtifact({
        ...details,
        downloadOptions: { ...details.downloadOptions, signal: AbortSignal.timeout(120_000) },
      })
    } catch (error) {
      const status = error.response?.status
      const transient = status === 408 || status === 429 || status >= 500 && status < 600 ||
        error.name === "TimeoutError" || error.name === "AbortError" ||
        error instanceof TypeError && error.message === "fetch failed" ||
        ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(error.cause?.code)
      const failure = status ? new Error(`Electron download failed: HTTP ${status}`) : error
      if (status) await error.response.body?.cancel()
      if (!transient || attempt === 4) throw failure
      const delay = 1_000 * 2 ** attempt
      console.warn(`Electron download failed (${status ? `HTTP ${status}` : error.name}); retrying in ${delay / 1_000}s (${attempt + 2}/5)`)
      await setTimeout(delay)
    }
  }
}
