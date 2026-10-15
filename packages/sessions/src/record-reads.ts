import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { z } from "zod"
import type { ThreadRef } from "./format.js"
import { keptOutputsPath } from "./kept-outputs.js"
import type { SessionProvider } from "./providers/types.js"
import type { NativeStores } from "./read-only-sqlite.js"
import type { SavedHistoryReader } from "./readers.js"
import type { RecordStore } from "./record-store.js"

/** Under the record store's folder: one home per session read back. */
export const RESTORED = "restored"
const MARK = ".mako-restored.json"
const MarkSchema = z.object({ capturedAt: z.number() })

/** How to make readers like the catalog's own, over a restored home. */
export interface ReadBack {
  readers: readonly SavedHistoryReader[]
  stores: NativeStores
}

/** A session's records restored where a reader can read them: its path there, and the reader. */
export interface RestoredSession {
  provider: SessionProvider
  path: string
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
  private readonly restoring = new Map<string, Promise<RestoredSession | null>>()

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

  /** The session `ref` names, restored; null when the store holds none of it or `ref.path` isn't under the machine's home. */
  read(ref: Pick<ThreadRef, "harness" | "nativeId" | "path">): Promise<RestoredSession | null> {
    const key = `${ref.harness}\n${ref.nativeId}`
    const running = this.restoring.get(key)
    if (running) return running
    const work = this.readNow(ref).finally(() => this.restoring.delete(key))
    this.restoring.set(key, work)
    return work
  }

  private async readNow(ref: Pick<ThreadRef, "harness" | "nativeId" | "path">): Promise<RestoredSession | null> {
    const within = relative(this.home, ref.path)
    if (!within || within.startsWith("..") || isAbsolute(within) || !this.holds(ref.harness, ref.nativeId)) return null
    const home = join(this.folder, ref.harness, createHash("sha256").update(ref.nativeId).digest("hex").slice(0, 32))
    const capturedAt = this.store.captures({ harness: ref.harness, nativeId: ref.nativeId, limit: 1 })[0]?.at ?? 0
    const mark = join(home, MARK)
    const marked = MarkSchema.safeParse(JSON.parse(await readFile(mark, "utf8").catch(() => "null"))).data
    if (marked?.capturedAt !== capturedAt) {
      // A harness deleting a session is never captured (`SessionCatalog.noticed`
      // takes writes only), so the newest versions are the session as it was.
      const restore = { harness: ref.harness, nativeId: ref.nativeId, home }
      let report = await this.store.restore(restore)
      if (report.diverged.length) {
        await rm(home, { recursive: true, force: true })
        report = await this.store.restore(restore)
      }
      if (report.diverged.length) return null
      await mkdir(home, { recursive: true })
      await writeFile(mark, JSON.stringify({ capturedAt }))
    }
    const path = join(home, within)
    const place = { home, kept: keptOutputsPath(this.home) }
    for (const reader of this.readers) {
      const provider = reader(this.stores, place)
      if (provider.roots().some((root) => path === root || path.startsWith(`${root}/`))) return { provider, path }
    }
    return null
  }
}
