import {
  SessionModelSchema,
  SessionSettingsSchema,
  type SessionSettings,
} from "@mako/sessions/settings"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { makoUserRoot } from "@mako/sessions/mako-root"
import { join } from "node:path"
import { z } from "zod"
import type { HarnessProfile } from "../contracts/providers-acp.js"
import { publishFile } from "../base/published-files.js"
import { JsonValueSchema, jsonStoreAccess } from "@mako/sessions/store-format"

const profileSchema = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  transport: z.enum(["acp", "app-server", "sdk", "remote"]),
  models: z.array(SessionModelSchema),
  defaultModel: z.string().optional(),
  configuredModel: z.string().optional(),
  settings: SessionSettingsSchema.optional(),
  configurationError: z.string().optional(),
  error: z.string().optional(),
})
// Entries, folders and the file itself are loose: what a newer Mako adds to one is written back as it was found.
const entrySchema = z.looseObject({ hash: z.string(), savedAt: z.number(), stamp: z.string().optional() })
const folderSchema = z.looseObject({
  account: z.string(),
  savedAt: z.number(),
  settings: SessionSettingsSchema.optional(),
  configuredModel: z.string().optional(),
})
const fileSchema = z.looseObject({
  version: z.literal(3),
  entries: z.record(z.string(), entrySchema),
  snapshots: z.record(z.string(), profileSchema),
  folders: z.record(z.string(), folderSchema).optional(),
})

type CacheFile = z.infer<typeof fileSchema>
type Entry = z.infer<typeof entrySchema>
type Folder = z.infer<typeof folderSchema>

const EMPTY: CacheFile = { version: 3, entries: {}, snapshots: {} }
/** Accounts kept: one entry each, so a handful in practice. */
const MAX_ENTRIES = 64
/** Folders whose own defaults are kept; each is a line, not a catalog. */
const MAX_FOLDERS = 64
/**
 * An unchanged catalog is written again only to say it was confirmed, and no more often than this: the next host
 * reads how old a snapshot is from `savedAt`, and a discovery that found nothing new otherwise writes nothing.
 */
export const CONFIRMED_EVERY_MS = 60 * 60_000

/** A snapshot as it was kept: when it was last confirmed, and the runtime it was read from where the harness says. */
export interface KeptProfile {
  profile: HarnessProfile
  savedAt: number
  stamp?: string
}

/** Where the cache is in a user root (`HostEnvironment.userRoot`), one file for every profile of the user. */
export function providerProfilesPath(userRoot: string): string {
  return join(userRoot, "provider-profiles.json")
}

function contentHash(profile: HarnessProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex")
}

/** What an account lists whatever the folder: its models and the one its harness defaults to. */
export function accountCatalog(profile: HarnessProfile): HarnessProfile {
  const catalog: HarnessProfile = {
    id: profile.id,
    label: profile.label,
    available: profile.available,
    transport: profile.transport,
    models: profile.models,
  }
  if (profile.defaultModel !== undefined) catalog.defaultModel = profile.defaultModel
  return catalog
}

/** What a folder's own configuration decides of a profile. */
export interface FolderDefaults {
  settings?: SessionSettings
  configuredModel?: string
}

/** What a folder's own configuration decides: the harness's defaults there and the model it is configured with. */
function folderFields(from: FolderDefaults): FolderDefaults {
  return {
    ...(from.settings && { settings: from.settings }),
    ...(from.configuredModel !== undefined && { configuredModel: from.configuredModel }),
  }
}

const sameFolder = (left: Folder | undefined, right: ReturnType<typeof folderFields>) =>
  left !== undefined && JSON.stringify(folderFields(left)) === JSON.stringify(right)

/** An earlier build's entry for one of the account's folders: the account's key, then the folder's path. */
const folderEntryOf = (account: string, key: string) =>
  key.startsWith(account) && /^(?:[\\/]|[A-Za-z]:[\\/])/.test(key.slice(account.length))

/**
 * The last working catalog of each harness account, kept across host starts.
 *
 * A model list belongs to the account, so the file holds one entry per account (`<harness>:<account>:`) whose
 * snapshot is the list alone, and a line per folder for what that folder's own configuration decides. Before this
 * every folder kept a whole profile: thirty folders of six harnesses made a 933 KB file that every discovery
 * rewrote. An earlier build's per-folder entries are still read, and dropped as their account is next saved.
 *
 * Every host of the user shares the file, so a write reads it again first and keeps whatever another host saved
 * since (the newer of two entries by `savedAt`).
 */
export class ProviderProfileCache {
  private file: CacheFile = structuredClone(EMPTY)
  /** The file is a newer Mako's cache: this host caches in memory and leaves the file to it. */
  private declined = false
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()
  /** What this host removed and when, so a merge with the file doesn't bring it back. */
  private readonly dropped = new Map<string, number>()
  private readonly path: string

  /** The user's own cache unless a host hands its user root's (`providerProfilesPath`). */
  constructor(path = providerProfilesPath(makoUserRoot())) {
    this.path = path
  }

  /**
   * The account's catalog with `folder`'s own defaults, when that folder was discovered under this account. `folder`
   * is the folder's whole key, which starts with the account's.
   */
  async get(account: string, folder: string): Promise<KeptProfile | null> {
    await this.load()
    const own = this.file.folders?.[folder]
    if (own?.account === account) {
      const kept = this.kept(account)
      if (kept) return { ...kept, profile: { ...accountCatalog(kept.profile), ...folderFields(own) } }
    }
    // An earlier build kept the folder's whole profile under the folder's key.
    return folderEntryOf(account, folder) ? this.kept(folder) : null
  }

  /**
   * The account's catalog without any folder's defaults: what a folder this account was never discovered in lists
   * until it is. From an earlier build's file, its most recently saved folder.
   */
  async catalog(account: string): Promise<KeptProfile | null> {
    await this.load()
    const kept = this.kept(account) ?? this.newest((key) => folderEntryOf(account, key))
    return kept ? { ...kept, profile: accountCatalog(kept.profile) } : null
  }

  /**
   * Each folder this account was discovered in, newest first, with what its own configuration decided: what a folder
   * of the same repository may be lent. `folder` is the folder's path.
   */
  async folders(account: string): Promise<{ folder: string; savedAt: number; fields: FolderDefaults }[]> {
    await this.load()
    return Object.entries(this.file.folders ?? {})
      .filter(([key, kept]) => kept.account === account && key.length > account.length && key.startsWith(account))
      .map(([key, kept]) => ({ folder: key.slice(account.length), savedAt: kept.savedAt, fields: folderFields(kept) }))
      .sort((left, right) => right.savedAt - left.savedAt)
  }

  /** The most recently saved working catalog under a key prefix, as a harness's name: what recording a catalog reads. */
  async nearest(prefix: string): Promise<HarnessProfile | null> {
    await this.load()
    return this.newest((key) => key.startsWith(prefix))?.profile ?? null
  }

  /**
   * Keeps what a discovery of `folder` under `account` reported. Answers whether anything was written: a catalog and
   * defaults that are already there write nothing until `CONFIRMED_EVERY_MS` has passed since they were confirmed.
   */
  async put(account: string, folder: string, profile: HarnessProfile, stamp?: string): Promise<boolean> {
    await this.load()
    const catalog = accountCatalog(profile)
    const hash = contentHash(catalog)
    const fields = folderFields(profile)
    const entry = this.file.entries[account]
    const now = Date.now()
    // A folder whose configuration couldn't be read has no defaults worth keeping; its catalog still is.
    const folderKept = Boolean(profile.configurationError) || sameFolder(this.ownFolder(account, folder), fields)
    const legacy = Object.keys(this.file.entries).filter((key) => folderEntryOf(account, key))
    if (entry?.hash === hash && entry.stamp === stamp && folderKept && !legacy.length && now - entry.savedAt < CONFIRMED_EVERY_MS)
      return false
    this.file.snapshots[hash] = catalog
    this.file.entries[account] = { ...entry, hash, savedAt: now, ...(stamp !== undefined && { stamp }) }
    if (stamp === undefined) delete this.file.entries[account]?.stamp
    for (const key of legacy) {
      delete this.file.entries[key]
      this.dropped.set(key, now)
    }
    if (!profile.configurationError) {
      const previous = this.ownFolder(account, folder)
      const next: Folder = { ...previous, account, savedAt: now, ...fields }
      if (!fields.settings) delete next.settings
      if (fields.configuredModel === undefined) delete next.configuredModel
      this.file.folders = { ...this.file.folders, [folder]: next }
    }
    this.dropped.delete(account)
    this.writes = this.writes.then(() => this.persist())
    await this.writes
    return true
  }

  async clear(account?: string): Promise<void> {
    await this.load()
    const now = Date.now()
    for (const key of Object.keys(this.file.entries)) {
      if (account !== undefined && key !== account) continue
      delete this.file.entries[key]
      this.dropped.set(key, now)
    }
    for (const [key, folder] of Object.entries(this.file.folders ?? {})) {
      if (account !== undefined && folder.account !== account) continue
      delete this.file.folders?.[key]
      this.dropped.set(`folder:${key}`, now)
    }
    this.writes = this.writes.then(() => this.persist())
    await this.writes
  }

  private ownFolder(account: string, folder: string): Folder | undefined {
    const own = this.file.folders?.[folder]
    return own?.account === account ? own : undefined
  }

  private kept(key: string): KeptProfile | null {
    const entry = this.file.entries[key]
    const profile = entry ? this.file.snapshots[entry.hash] : undefined
    if (!entry || !profile) return null
    return { profile, savedAt: entry.savedAt, ...(entry.stamp !== undefined && { stamp: entry.stamp }) }
  }

  private newest(among: (key: string) => boolean): KeptProfile | null {
    let best: KeptProfile | null = null
    for (const key of Object.keys(this.file.entries)) {
      if (!among(key)) continue
      const kept = this.kept(key)
      if (!kept?.profile.available || kept.profile.configurationError) continue
      if (!best || kept.savedAt > best.savedAt) best = kept
    }
    return best
  }

  private async read(): Promise<{ file: CacheFile; declined: boolean }> {
    try {
      const parsed = JsonValueSchema.parse(JSON.parse(await readFile(this.path, "utf8")))
      const declined = jsonStoreAccess(parsed, EMPTY.version) !== "write"
      const result = fileSchema.safeParse(parsed)
      return { file: result.success ? result.data : structuredClone(EMPTY), declined }
    } catch {
      return { file: structuredClone(EMPTY), declined: false }
    }
  }

  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      const { file, declined } = await this.read()
      this.file = file
      this.declined = declined
    })()
    await this.loaded
  }

  /** What the file holds now, with this host's entries over it wherever they are the newer. */
  private merge(disk: CacheFile): void {
    const mine = this.file
    const newer = <T extends { savedAt: number }>(name: string, theirs: T | undefined, ours: T | undefined): T | undefined => {
      if (theirs && (this.dropped.get(name) ?? -1) >= theirs.savedAt) theirs = undefined
      return !theirs || (ours && ours.savedAt >= theirs.savedAt) ? ours : theirs
    }
    const entries: Record<string, Entry> = {}
    for (const key of new Set([...Object.keys(disk.entries), ...Object.keys(mine.entries)])) {
      const entry = newer(key, disk.entries[key], mine.entries[key])
      if (entry) entries[key] = entry
    }
    const folders: Record<string, Folder> = {}
    for (const key of new Set([...Object.keys(disk.folders ?? {}), ...Object.keys(mine.folders ?? {})])) {
      const folder = newer(`folder:${key}`, disk.folders?.[key], mine.folders?.[key])
      if (folder) folders[key] = folder
    }
    const latest = <T extends { savedAt: number }>(all: Record<string, T>, limit: number) =>
      Object.fromEntries(Object.entries(all).sort(([, left], [, right]) => right.savedAt - left.savedAt).slice(0, limit))
    const kept = latest(entries, MAX_ENTRIES)
    const retained = new Set(Object.values(kept).map((entry) => entry.hash))
    // The file's own fields over this host's copy of them, so one a newer Mako added is written back as it stands.
    this.file = {
      ...mine,
      ...disk,
      entries: kept,
      snapshots: Object.fromEntries(Object.entries({ ...disk.snapshots, ...mine.snapshots }).filter(([hash]) => retained.has(hash))),
      folders: latest(folders, MAX_FOLDERS),
    }
  }

  private async persist(): Promise<void> {
    if (this.declined) return
    const { file, declined } = await this.read()
    // A newer Mako took the file over while this host ran: it is theirs from here.
    if (declined) {
      this.declined = true
      return
    }
    this.merge(file)
    await publishFile(this.path, JSON.stringify(this.file), { mode: 0o600, dirMode: 0o700 })
  }
}
