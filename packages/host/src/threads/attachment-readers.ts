import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { z } from "zod"
import { isLoopbackOrigin, type AttachmentHold, type AttachmentReaders, type BrowserStore } from "@mako/sessions/attachment-sweep"
import { openReadOnly } from "@mako/sessions/read-only-sqlite"
import { chromiumProfileRoots } from "../base/chromium-profiles.js"
import { hostLockHolder } from "../base/host-lock.js"
import { DeskBrowserFamilySchema, deskClientsPath, NOTE_EVERY_MS, readDeskClients, type DeskBrowserFamily } from "../base/desk-clients.js"

/**
 * Every place on this machine a reader of Mako's attachment files keeps the
 * stores that name them (`AttachmentReaders`), asked by the attachments'
 * sweep each pass:
 *
 * - **Mako's roots.** The installed app's data root, `dev`, every sandbox,
 *   review and fixture profile, and each desktop client's renderer folder
 *   beside them (`<data root>-ui-<client>`), whose localStorage holds
 *   drafts. A profile's data root is `<appData>/<app>` or
 *   `<appData>/<app>-<profile>` (`resolveHostEnvironment`), so listing
 *   `appData` finds every one, running or not; a host started with
 *   `MAKO_DATA_ROOT` outside `appData` registers its launch in the session
 *   ledger (`runtime_hosts`) while it runs, and is added with its clients.
 * - **Browsers a development desk opened in.** A desk served by Vite keeps
 *   its drafts in that browser's localStorage, under a loopback origin (the
 *   port moves, so every loopback origin is read). Every Chromium-family
 *   user-data root (found by its `Local State`, as the browser extension's
 *   setup finds them) and each of its profiles; Firefox's per-origin stores
 *   for loopback origins; Safari's when its container can be read (Full
 *   Disk Access).
 * - **Holds.** A browser whose storage can't be read holds every file that
 *   existed while a desk ran in it, which the desk-client record says
 *   (`desk-clients.ts`). Before that record began nobody can say, so every
 *   staged file from then is held: drafts have no retention. And a profile
 *   whose host runs (it holds the data root's lock) a build that doesn't
 *   restart a reused file's times, or one the session ledger can't name
 *   (`liveAssetsTouch` on its launch), holds its whole `LiveAssets`: that
 *   host may hand an old file to a prompt the moment the sweep takes it.
 *
 * A folder that can't be listed is returned as unreadable, which the sweep
 * treats as naming everything.
 */
export async function attachmentReaders(input: { appData: string; app: string; dataRoot: string; sessionMemory: string; home: string; platform?: NodeJS.Platform; now?: number }): Promise<AttachmentReaders> {
  const unreadable: AttachmentReaders["unreadable"] = []
  const launches = await registered(input.sessionMemory, unreadable)
  const roots = await makoRoots(input, [...launches.keys()], unreadable)
  const found = await browserStores(input, new Set(roots))
  const now = input.now ?? Date.now()
  const record = await readDeskClients(deskClientsPath(input.home))
  const holds: AttachmentHold[] = [{
    kinds: ["staged"],
    through: record?.since ?? now,
    why: "drafts of a desk opened before Mako recorded which browsers open one",
  }]
  const unknown = new Set<DeskBrowserFamily>(["other", ...found.unreadable])
  for (const [family, seen] of Object.entries(record?.browsers ?? {})) {
    if (!unknown.has(DeskBrowserFamilySchema.catch("other").parse(family))) continue
    holds.push({ kinds: ["archive", "live", "staged"], through: seen.lastSeen + NOTE_EVERY_MS, why: `drafts of a desk opened in ${family}, whose storage can't be read` })
  }
  for (const root of roots) {
    if (!existsSync(join(root, "conversations", "assets"))) continue
    const holder = await hostLockHolder(root, input.platform)
    if (holder === null) continue
    const launch = launches.get(root)
    if (launch?.liveAssetsTouch) continue
    holds.push({
      kinds: ["live"], root, through: Number.MAX_SAFE_INTEGER,
      why: `${basename(root)}'s running host (pid ${holder}) ${launch ? "is a build that doesn't restart a reused file's times" : "is a build the session ledger doesn't name"}; its LiveAssets wait until it's gone or updated`,
    })
  }
  return { roots, browsers: found.browsers, holds, unreadable }
}

async function makoRoots(input: { appData: string; app: string; dataRoot: string }, outside: string[], unreadable: AttachmentReaders["unreadable"]): Promise<string[]> {
  const roots = new Set<string>([resolve(input.dataRoot)])
  const siblings = async (folder: string, prefix: string) => {
    try {
      // Case aside: macOS's and Windows's folders don't tell `Mako` from `mako`, and reading one more folder costs nothing.
      const own = prefix.toLowerCase()
      for (const name of await readdir(folder)) {
        const lower = name.toLowerCase()
        if (lower === own || lower.startsWith(`${own}-`)) roots.add(join(folder, name))
      }
    } catch (error) {
      if (!Gone.safeParse(error).success) unreadable.push({ path: folder, why: String(error) })
    }
  }
  await siblings(input.appData, input.app)
  const appData = resolve(input.appData)
  for (const root of [resolve(input.dataRoot), ...outside]) {
    if (root === appData || root.startsWith(appData + sep)) continue
    roots.add(root)
    // Its clients' renderer folders are `<root>-ui-<client>` beside it.
    await siblings(dirname(root), basename(root))
  }
  return [...roots].sort()
}

/** The browsers' stores read for desk drafts, and the families whose stores exist but can't be read. */
async function browserStores(input: { appData: string; home: string; platform?: NodeJS.Platform }, mako: Set<string>): Promise<{ browsers: BrowserStore[]; unreadable: DeskBrowserFamily[] }> {
  const browsers: BrowserStore[] = []
  const unreadable: DeskBrowserFamily[] = []
  const platform = input.platform ?? process.platform
  const children = async (folder: string): Promise<string[] | "unreadable"> => {
    try {
      return (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name)).sort()
    } catch (error) {
      return Gone.safeParse(error).success ? [] : "unreadable"
    }
  }
  // Chromium's family: every user-data root, each profile folder in it (Default, Profile 1, Guest Profile…).
  for (const root of await chromiumProfileRoots(input.appData)) {
    if (mako.has(root)) continue
    const profiles = await children(root)
    if (profiles === "unreadable") continue
    for (const profile of profiles.slice(0, 64)) {
      const folder = join(profile, "Local Storage", "leveldb")
      if (existsSync(folder)) browsers.push({ path: folder, kind: "chromium", label: `${basename(root)} ${basename(profile)}` })
    }
  }
  // Firefox: one store per origin (`storage/default/http+++127.0.0.1+5173/ls/data.sqlite`), and the store before it.
  const firefox = platform === "darwin" ? join(input.appData, "Firefox", "Profiles") : join(input.home, ".mozilla", "firefox")
  const profiles = existsSync(firefox) ? await children(firefox) : []
  if (profiles === "unreadable") unreadable.push("firefox")
  else {
    for (const profile of profiles) {
      const origins = await children(join(profile, "storage", "default"))
      if (origins === "unreadable") {
        unreadable.push("firefox")
        continue
      }
      for (const folder of origins) {
        const store = join(folder, "ls", "data.sqlite")
        if (isLoopbackOrigin(firefoxOrigin(basename(folder))) && existsSync(store)) browsers.push({ path: store, kind: "firefox", label: `firefox ${basename(profile)} ${basename(folder)}` })
      }
      const legacy = join(profile, "webappsstore.sqlite")
      if (existsSync(legacy)) browsers.push({ path: legacy, kind: "webkit", label: `firefox ${basename(profile)} webappsstore` })
    }
  }
  // Safari keeps its storage in its container, which only an app with Full Disk Access reads.
  if (platform === "darwin") {
    const website = join(input.home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "WebKit", "WebsiteData", "Default")
    const salts = await children(website)
    if (salts === "unreadable") unreadable.push("safari")
    else {
      for (const salt of salts) {
        const origins = await children(salt)
        if (origins === "unreadable") continue
        for (const origin of origins) {
          const store = join(origin, "LocalStorage", "localstorage.sqlite3")
          if (existsSync(store)) browsers.push({ path: store, kind: "webkit", label: `safari ${basename(origin).slice(0, 12)}` })
        }
      }
    }
  }
  return { browsers, unreadable: [...new Set(unreadable)] }
}

/** Firefox's folder name for an origin: `http+++127.0.0.1+5173`, `^userContextId=…` for a container. */
export function firefoxOrigin(folder: string): string {
  const plain = folder.split("^")[0]!
  const scheme = plain.indexOf("+++")
  if (scheme < 0) return ""
  const rest = plain.slice(scheme + 3)
  const port = /\+(\d+)$/.exec(rest)
  return `${plain.slice(0, scheme)}://${port ? `${rest.slice(0, port.index)}:${port[1]}` : rest}`
}

/** The launches the session ledger lists, by data root; none when there's no ledger yet. */
async function registered(path: string, unreadable: AttachmentReaders["unreadable"]): Promise<Map<string, Launch>> {
  const launches = new Map<string, Launch>()
  if (!existsSync(path)) return launches
  try {
    const { database } = openReadOnly(path, { timeout: 2_000 })
    try {
      const table = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'runtime_hosts'").get()
      if (!table) return launches
      for (const row of z.object({ launch: z.string() }).array().parse(database.prepare("SELECT launch FROM runtime_hosts").all())) {
        const launch = LaunchText.safeParse(row.launch)
        if (launch.success && existsSync(launch.data.dataRoot)) launches.set(resolve(launch.data.dataRoot), launch.data)
      }
      return launches
    } finally {
      database.close()
    }
  } catch (error) {
    unreadable.push({ path, why: String(error) })
    return launches
  }
}

/** A ledger row's launch, of which its data root and whether its build restarts a reused file's times are read; a row that isn't JSON names none. */
const LaunchText = z.string().transform((text, context) => {
  try {
    return JSON.parse(text)
  } catch {
    context.addIssue({ code: "custom", message: "The launch isn't JSON" })
    return z.NEVER
  }
}).pipe(z.object({ dataRoot: z.string().min(1), liveAssetsTouch: z.literal(true).optional() }))
type Launch = z.infer<typeof LaunchText>
/** An error that says the folder is gone: there is nothing in it to name. */
const Gone = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) })
