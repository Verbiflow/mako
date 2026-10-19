/**
 * A decode aside (`decode-aside.ts`): reads one job from its parent, decodes
 * the record with the reader the job names, writes its view, answers and
 * exits.
 */
import { AsideJobSchema, type AsideJob, type AsideReply } from "./decode-aside.js"
import { NativeStores } from "./read-only-sqlite.js"
import { SAVED_HISTORY_READERS } from "./readers.js"
import { ViewCache } from "./view-cache.js"
import { UNREAD_INDEX_FILE, UnreadIndex } from "./unread-index.js"
import { join } from "node:path"

async function decode(job: AsideJob): Promise<AsideReply> {
  const reader = SAVED_HISTORY_READERS[job.reader]
  if (!reader) return { ok: false, error: `no reader ${job.reader}` }
  const provider = reader(new NativeStores(job.strict))
  try {
    const started = performance.now()
    const thread = await provider.read(job.path)
    if (!thread) return { ok: false, error: "the record doesn't read" }
    const decodeMs = performance.now() - started
    // The catalog's index, beside the views: a large session's unread records are counted like any other's.
    const unread = new UnreadIndex(join(job.viewsPath, UNREAD_INDEX_FILE))
    try {
      const views = new ViewCache(job.viewsPath, () => job.translator, undefined, unread)
      await views.write(job.path, job.stamp, thread, decodeMs)
      await views.settled()
    } finally {
      unread.close()
    }
    return { ok: true, entries: thread.entries.length, decodeMs }
  } finally {
    provider.close?.()
  }
}

process.once("message", (message) => {
  const job = AsideJobSchema.safeParse(message)
  const decoded: Promise<AsideReply> = job.success ? decode(job.data) : Promise.resolve({ ok: false, error: "the job doesn't parse" })
  void decoded
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }) satisfies AsideReply)
    .then((reply) => process.send?.(reply, () => process.exit(0)) ?? process.exit(1))
})
