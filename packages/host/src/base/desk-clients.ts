import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"

/**
 * Which browsers have opened a development desk on this machine, and when
 * (`~/.mako/desk-clients.json`). A desk served by Vite (`npm run web`)
 * keeps its drafts in the localStorage of whichever browser opened it, and a
 * draft names the files it stages. The attachments' sweep reads every
 * browser storage it can; one it can't (Safari's, inside its container)
 * holds every file that existed while a desk ran there, which only this
 * record can say. `since` is when the record began: before it, nobody knows.
 *
 * The web launcher's proxy notes each browser family on the first call
 * through it, then at most every `NOTE_EVERY_MS` while it keeps calling; a
 * reader treats a family as possibly running up to `NOTE_EVERY_MS` past its
 * `lastSeen`.
 */

export const NOTE_EVERY_MS = 5 * 60_000

export const DeskBrowserFamilySchema = z.enum(["chromium", "electron", "firefox", "safari", "other"])
export type DeskBrowserFamily = z.infer<typeof DeskBrowserFamilySchema>

const DeskClientsSchema = z.object({
  version: z.literal(1),
  since: z.number(),
  browsers: z.record(z.string(), z.object({ firstSeen: z.number(), lastSeen: z.number(), origins: z.array(z.string()) })),
})
export type DeskClientsRecord = z.infer<typeof DeskClientsSchema>

const MAX_ORIGINS = 32

export function deskClientsPath(home = homedir()): string {
  return join(home, ".mako", "desk-clients.json")
}

/** The browser family a user agent names; Chromium's forks and Electron before WebKit, which every one of them also names. */
export function browserFamily(userAgent: string | undefined): DeskBrowserFamily {
  if (!userAgent) return "other"
  if (/\bElectron\//.test(userAgent)) return "electron"
  if (/\b(Firefox|FxiOS)\//.test(userAgent)) return "firefox"
  if (/\b(Chrome|Chromium|CriOS|Edg|OPR)\//.test(userAgent)) return "chromium"
  if (/\bAppleWebKit\//.test(userAgent)) return "safari"
  return "other"
}

/** The record as written, or null when there is none or it can't be read. */
export async function readDeskClients(path = deskClientsPath()): Promise<DeskClientsRecord | null> {
  const text = await readFile(path, "utf8").catch(() => null)
  if (text === null) return null
  try {
    return DeskClientsSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/** One launcher's notes: each family at most every `NOTE_EVERY_MS`, merged into what other launchers wrote. */
export class DeskClients {
  private readonly noted = new Map<DeskBrowserFamily, number>()
  private writing: Promise<void> = Promise.resolve()

  private readonly path: string
  private readonly now: () => number

  constructor(path = deskClientsPath(), now: () => number = Date.now) {
    this.path = path
    this.now = now
  }

  note(userAgent: string | undefined, origin: string | undefined): void {
    const family = browserFamily(userAgent)
    const at = this.now()
    if (at - (this.noted.get(family) ?? Number.NEGATIVE_INFINITY) < NOTE_EVERY_MS) return
    this.noted.set(family, at)
    this.writing = this.writing.then(() => this.write(family, origin, at)).catch(() => {
      // A note that can't be written is noted again at the next call.
      this.noted.delete(family)
    })
  }

  /** Waits for the notes in flight; for tests and a launcher's exit. */
  settled(): Promise<void> {
    return this.writing
  }

  private async write(family: DeskBrowserFamily, origin: string | undefined, at: number): Promise<void> {
    const record = (await readDeskClients(this.path)) ?? { version: 1 as const, since: at, browsers: {} }
    const entry = record.browsers[family] ?? { firstSeen: at, lastSeen: at, origins: [] }
    entry.lastSeen = Math.max(entry.lastSeen, at)
    if (origin && !entry.origins.includes(origin)) entry.origins = [...entry.origins, origin].slice(-MAX_ORIGINS)
    record.browsers[family] = entry
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
