import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { z } from "zod"
import type { ThreadRef } from "./format.js"
import { keptOutputsPath } from "./kept-outputs.js"
import type { SessionProvider } from "./providers/types.js"
import type { NativeStores } from "./read-only-sqlite.js"
import type { SavedHistoryReader } from "./readers.js"
import { plainRecordPath } from "./record-files.js"
import type { RecordStore } from "./record-store.js"

/** Under the record store's folder: one home per session read back. */
export const RESTORED = "restored"
const MARK = ".mako-restored.json"
/** A home's mark: the capture it was restored from, and its children's transcripts not written yet, by their place in it. */
const MarkSchema = z.object({ capturedAt: z.number(), deferred: z.array(z.string()).optional() })

/** How to make readers like the catalog's own, over a restored home. */
export interface ReadBack {
  readers: readonly SavedHistoryReader[]
  stores: NativeStores
}

/** A session's records restored where a reader can read them: its path there, the reader, and the home they were restored into. */
export interface RestoredSession {
  provider: SessionProvider
  path: string
  home: string
}

/**
 * Sessions read back from the record store once their harness no longer has
 * them. Each is restored into a home of its own under the store's folder,
 * never the machine's, so no harness sees it and nothing it does to its own
 * store is undone. A restore is taken again only when the store captured
 * the session since, and every reader reads the restored copy as it would
 * the original.
 */
export class RecordReads {
  /** Homes being restored, by session and time: a session and its children read at once share one. */
  private readonly restoring = new Map<string, Promise<string | null>>()
  /** The readers made over each restored home, the most recent last: a parent and its children are read by the same ones. */
  private readonly readersAt = new Map<string, SessionProvider[]>()
  /** Each current home's children's transcripts not written yet: each is written when it's first read. */
  private readonly deferred = new Map<string, Set<string>>()
  /** Children's transcripts being written, by where they go. */
  private readonly writingChild = new Map<string, Promise<boolean>>()
  /** Each home's mark, written one after another. */
  private readonly marking = new Map<string, Promise<void>>()

  constructor(
    private readonly store: RecordStore,
    private readonly folder: string,
    private readonly readers: readonly SavedHistoryReader[],
    private readonly stores: NativeStores,
    private readonly home: string
  ) {}

  /** Whether the store holds any of the session's records. */
  holds(harness: string, nativeId: string): boolean {
    return this.store.units(harness, nativeId).length > 0
  }

  /**
   * The session `ref` names, restored: as it last was, or as Mako had
   * captured it by `asOf`, in a home of that time's own, which never changes
   * once written. `ref.path` is the session's, or one of its child agents'
   * (`RecordStore.parentAt`), whose records are the session's. Null when the
   * store holds none of it or `ref.path` isn't under the machine's home.
   */
  async read(ref: Pick<ThreadRef, "harness" | "nativeId" | "path">, asOf?: number): Promise<RestoredSession | null> {
    const within = relative(this.home, ref.path)
    if (!within || within.startsWith("..") || isAbsolute(within) || !this.holds(ref.harness, ref.nativeId)) return null
    const key = `${ref.harness}\n${ref.nativeId}\n${asOf ?? ""}`
    let work = this.restoring.get(key)
    if (!work) {
      work = (asOf === undefined ? this.readNow(ref) : this.readAsOf(ref, asOf)).finally(() => this.restoring.delete(key))
      this.restoring.set(key, work)
    }
    const home = await work
    if (!home) return null
    // A child's transcript is written when it's first read, not with its parent's home.
    const target = plainRecordPath(join(home, within))
    if (asOf === undefined && this.deferred.get(home)?.has(target) && !(await this.writeChild(ref, home, target))) return null
    return this.readerAt(home, within)
  }

  /** Where `path`, read in a home restored at `home`, is on this machine: what a child listed there is opened by. */
  original(path: string, home: string): string {
    const within = relative(home, path)
    return !within || within.startsWith("..") || isAbsolute(within) ? path : join(this.home, within)
  }

  /** Where `path`, of the session `harness` and `nativeId` name or one of its children, is read in the session's current restored home; null outside the machine's home. */
  restoredPath(harness: string, nativeId: string, path: string): string | null {
    const within = relative(this.home, path)
    return !within || within.startsWith("..") || isAbsolute(within) ? null : join(this.folder, harness, homeName(nativeId), within)
  }

  /** Whether the session has a current home it was read back into. */
  hasHome(harness: string, nativeId: string): boolean {
    return existsSync(join(this.folder, harness, homeName(nativeId), MARK))
  }

  /** Removes every home the session was restored into: the person deleted it, and its children with it. */
  async drop(harness: string, nativeId: string): Promise<void> {
    const name = homeName(nativeId)
    const folder = join(this.folder, harness)
    const homes = (await readdir(folder).catch(() => new Array<string>())).filter((entry) => entry === name || entry.startsWith(`${name}@`))
    for (const entry of homes) {
      this.readersAt.delete(join(folder, entry))
      this.deferred.delete(join(folder, entry))
    }
    await Promise.all(homes.map((entry) => rm(join(folder, entry), { recursive: true, force: true })))
  }

  private async readNow(ref: Pick<ThreadRef, "harness" | "nativeId">): Promise<string | null> {
    const home = join(this.folder, ref.harness, homeName(ref.nativeId))
    const capturedAt = this.store.captures({ harness: ref.harness, nativeId: ref.nativeId, limit: 1 })[0]?.at ?? 0
    const mark = join(home, MARK)
    const marked = MarkSchema.safeParse(JSON.parse(await readFile(mark, "utf8").catch(() => "null"))).data
    if (marked?.capturedAt !== capturedAt) {
      // A harness deleting a session is never captured (`SessionCatalog.noticed`
      // takes writes only), so the newest versions are the session as it was.
      // Its children's transcripts wait until each is read: the session and
      // its list of children read without them, and a child's own is written
      // then (`writeChild`). Each has its first line meanwhile
      // (`RestoreInput.files`), so a reader listing children finds it where
      // its harness kept it, and reads its head.
      const children = new Set(this.store.childPaths(ref.harness, ref.nativeId).flatMap((path) => {
        const at = within(this.home, path)
        return at === null ? [] : [plainRecordPath(join(home, at))]
      }))
      const restore = { harness: ref.harness, nativeId: ref.nativeId, home, ...children.size && { files: (target: string) => !children.has(target) } }
      this.readersAt.delete(home)
      let report = await this.store.restore(restore)
      if (report.diverged.length) {
        await rm(home, { recursive: true, force: true })
        report = await this.store.restore(restore)
      }
      if (report.diverged.length) return null
      const deferred = report.deferred ?? []
      await mkdir(home, { recursive: true })
      this.deferred.set(home, new Set(deferred))
      await this.mark(home, capturedAt)
    } else if (!this.deferred.has(home)) this.deferred.set(home, new Set((marked.deferred ?? []).map((at) => join(home, at))))
    return home
  }

  /**
   * Writes a child's transcript into its parent's home, from the parent's
   * records, the first time it's read. False when the records hold none
   * that fits there.
   */
  private writeChild(ref: Pick<ThreadRef, "harness" | "nativeId">, home: string, target: string): Promise<boolean> {
    let work = this.writingChild.get(target)
    if (!work) {
      work = (async () => {
        const restore = { harness: ref.harness, nativeId: ref.nativeId, home, files: (at: string) => at === target }
        let report = await this.store.restore(restore)
        if (report.diverged.length) {
          // Written from an earlier capture the session has gone on from since: written again whole.
          await rm(target, { force: true })
          report = await this.store.restore(restore)
        }
        if (report.diverged.length) return false
        this.deferred.get(home)?.delete(target)
        const capturedAt = MarkSchema.safeParse(JSON.parse(await readFile(join(home, MARK), "utf8").catch(() => "null"))).data?.capturedAt
        if (capturedAt !== undefined) await this.mark(home, capturedAt)
        return true
      })().finally(() => this.writingChild.delete(target))
      this.writingChild.set(target, work)
    }
    return work
  }

  /** Writes a home's mark with its children's transcripts still to write, after any mark before it. */
  private mark(home: string, capturedAt: number): Promise<void> {
    const write = (this.marking.get(home) ?? Promise.resolve()).then(() =>
      writeFile(join(home, MARK), JSON.stringify({ capturedAt, deferred: [...(this.deferred.get(home) ?? [])].map((target) => relative(home, target)) })))
    this.marking.set(home, write.catch(() => undefined))
    return write
  }

  private async readAsOf(ref: Pick<ThreadRef, "harness" | "nativeId">, asOf: number): Promise<string | null> {
    const home = join(this.folder, ref.harness, `${homeName(ref.nativeId)}@${Math.trunc(asOf)}`)
    const mark = join(home, MARK)
    if (!existsSync(mark)) {
      // A half-written home from a read that stopped is written again whole.
      await rm(home, { recursive: true, force: true })
      const report = await this.store.restoreAsOf({ harness: ref.harness, nativeId: ref.nativeId, home, asOf })
      if (report.diverged.length || !report.written) {
        await rm(home, { recursive: true, force: true })
        return null
      }
      await writeFile(mark, JSON.stringify({ capturedAt: asOf }))
    }
    return home
  }

  private readerAt(home: string, within: string): RestoredSession | null {
    const path = join(home, within)
    let providers = this.readersAt.get(home)
    if (providers) this.readersAt.delete(home)
    else {
      const place = { home, kept: keptOutputsPath(this.home) }
      providers = this.readers.map((reader) => reader(this.stores, place))
    }
    this.readersAt.set(home, providers)
    for (const stale of this.readersAt.keys()) {
      if (this.readersAt.size <= READERS_KEPT) break
      this.readersAt.delete(stale)
    }
    const provider = providers.find((candidate) => candidate.roots().some((root) => path === root || path.startsWith(`${root}/`)))
    return provider ? { provider, path, home } : null
  }
}

/** `path` under `home`, relative to it; null for one outside it. */
function within(home: string, path: string): string | null {
  const at = relative(home, path)
  return !at || at.startsWith("..") || isAbsolute(at) ? null : at
}

/** Restored homes whose readers are kept. */
const READERS_KEPT = 8

/** The folder, under its harness's, a session is restored into. */
const homeName = (nativeId: string) => createHash("sha256").update(nativeId).digest("hex").slice(0, 32)
