import { z } from "zod"
import type { MethodTable } from "@mako/host/base/methods"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { ThreadTitleEntry } from "@mako/host/contracts/thread-titles"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { ThreadStore } from "../thread-store.js"

const TitleSchema = z.string().max(400)
const ImportSchema = z.array(z.object({ thread: ThreadIdSchema, title: TitleSchema })).max(5_000)

/**
 * Threads' own names for every window: the ones to draw, a person's rename
 * of a whole Thread (or dropping it with `null`, so the row shows its first
 * Session's title again), and a window's renames from before the store kept
 * them. Every change is told to every window as `thread-titles`.
 */
export function installThreadTitlesIpc(methods: MethodTable, input: {
  store: ThreadStore | null
  emit(event: HostEvent): void
}) {
  const { store, emit } = input
  const tell = (titles: ThreadTitleEntry[]) => {
    if (titles.length) emit({ type: "thread-titles", titles })
  }
  methods.handle("mako:thread-titles", (): ThreadTitleEntry[] => store?.titles() ?? [])
  methods.handle("mako:thread-rename", (operationId: string, thread: string, title: string | null, original?: string): ThreadTitleEntry => {
    if (!store) throw new Error("This Mako couldn't open its Thread store, so it can't rename a Thread.")
    const operation = z.string().uuid().parse(operationId)
    const id = ThreadIdSchema.parse(thread)
    const named = TitleSchema.nullable().parse(title)
    const entry = named === null
      ? store.clearThreadTitle({ operationId: operation, thread: id, actor: store.person() })
      : store.titleEntry(store.renameThread({ operationId: operation, thread: id, title: named, original: TitleSchema.optional().parse(original), actor: store.person() }).id)
    if (!entry) throw new Error("That Thread no longer exists")
    tell([entry])
    return entry
  })
  methods.handle("mako:thread-titles-import", (entries: ReadonlyArray<{ thread: string; title: string }>): ThreadTitleEntry[] => {
    if (!store) return []
    const imported = store.importThreadTitles(ImportSchema.parse(entries))
    tell(imported)
    return imported
  })
}
