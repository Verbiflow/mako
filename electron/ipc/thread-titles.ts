import { registerIpc } from "./register.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { ThreadTitleEntry } from "../contracts/thread-titles.js"
import { ThreadIdSchema } from "../contracts/thread-identity.js"
import type { ThreadStore } from "../thread-store.js"
import type { ThreadTitler } from "../thread-titles.js"
import type { UtilityModelStore } from "../utility-model-store.js"

/**
 * Threads' names for every window: the ones to draw, a person's rename
 * (or giving the name back to automatic titles with `null`), a window's
 * renames from before the store kept them, and which model names Threads.
 * Every change is told to every window as `thread-titles`.
 */
export function installThreadTitlesIpc(input: {
  store: ThreadStore | null
  titler?: ThreadTitler
  models: UtilityModelStore
  emit(event: HostEvent): void
}) {
  const { store, titler, models, emit } = input
  const tell = (titles: ThreadTitleEntry[]) => {
    if (titles.length) emit({ type: "thread-titles", titles })
  }
  registerIpc("mako:thread-titles", (): ThreadTitleEntry[] => store?.titles() ?? [])
  registerIpc("mako:thread-rename", (_event, operationId: string, thread: string, title: string | null, original?: string): ThreadTitleEntry => {
    if (!store) throw new Error("This Mako couldn't open its Thread store, so it can't rename a Thread.")
    const id = ThreadIdSchema.parse(thread)
    titler?.cancel(id)
    const entry = title === null
      ? store.clearThreadTitle({ operationId, thread: id, actor: store.person() })
      : store.titleEntry(store.renameThread({ operationId, thread: id, title, original, actor: store.person() }).id)
    if (!entry) throw new Error("That Thread no longer exists")
    tell([entry])
    return entry
  })
  registerIpc("mako:thread-titles-import", (_event, entries: ReadonlyArray<{ thread: string; title: string }>): ThreadTitleEntry[] => {
    if (!store) return []
    const imported = store.importThreadTitles(entries.map((entry) => ({ thread: ThreadIdSchema.parse(entry.thread), title: entry.title })))
    tell(imported)
    return imported
  })
  registerIpc("mako:thread-title-model", async (_event, model: string | null): Promise<void> => {
    await models.setTitleModel(model)
    titler?.configure(model !== null)
  })
}
