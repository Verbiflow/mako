import { BrowserWindow } from "electron"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { DESK_ORIGIN, STORAGE_BRIDGE_DOCUMENT } from "./desk-scheme.js"

/**
 * Carry the renderer's localStorage from the `file://` origin the desk used
 * to load under into `mako-app://desk`, once per profile.
 *
 * Drafts, preferences and review notes live in localStorage, and Chromium
 * keys that by origin: the day the desk moved to its own scheme, every
 * profile would otherwise have opened empty. So before the first window of a
 * profile loads the desk, a hidden window opens the bundle's blank
 * `storage-bridge.html` on the old origin, reads every key, opens the same
 * page on the new origin and writes the keys that are not already there; the
 * marker file then records that the move happened. A profile with no
 * storage yet writes the marker and skips the windows. Nothing is deleted
 * from the old origin, and a failure leaves no marker, so the next start
 * tries again rather than losing a paragraph to a one-off error.
 */
const MARKER = "renderer-origin.json"
const MarkerSchema = z.object({ origin: z.string() })
const EntriesSchema = z.array(z.tuple([z.string(), z.string()]))
/** Long enough for a cold renderer, short enough that a stuck one cannot delay the desk. */
const STEP_TIMEOUT_MS = 8_000

export type StorageMoveResult =
  | { kind: "current" }
  | { kind: "fresh" }
  | { kind: "moved"; entries: number }
  | { kind: "failed"; error: string }

export async function adoptDeskOrigin(options: {
  userData: string
  dist: string
}): Promise<StorageMoveResult> {
  const marker = join(options.userData, MARKER)
  try {
    const recorded = MarkerSchema.parse(JSON.parse(await readFile(marker, "utf8")))
    if (recorded.origin === DESK_ORIGIN) return { kind: "current" }
  } catch {
    // No marker or an unreadable one: decide from the storage on disk.
  }
  const hasStorage = await access(join(options.userData, "Local Storage", "leveldb")).then(
    () => true,
    () => false
  )
  const record = async () => {
    await mkdir(options.userData, { recursive: true })
    await writeFile(marker, JSON.stringify({ origin: DESK_ORIGIN }), { mode: 0o600 })
  }
  if (!hasStorage) {
    await record()
    return { kind: "fresh" }
  }
  const window = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    const bridge = join(options.dist, "storage-bridge.html")
    await step(window.loadURL(pathToFileURL(bridge).href))
    const entries = EntriesSchema.parse(
      JSON.parse(
        z.string().parse(
          await step(window.webContents.executeJavaScript("JSON.stringify(Object.entries(localStorage))", true))
        )
      )
    )
    if (entries.length) {
      await step(window.loadURL(STORAGE_BRIDGE_DOCUMENT))
      await step(
        window.webContents.executeJavaScript(
          `for (const [key, value] of ${JSON.stringify(entries)}) if (localStorage.getItem(key) === null) localStorage.setItem(key, value); void 0`,
          true
        )
      )
    }
    await record()
    return { kind: "moved", entries: entries.length }
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

function step<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The storage move timed out")), STEP_TIMEOUT_MS)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
