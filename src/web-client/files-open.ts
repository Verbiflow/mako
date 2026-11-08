import { z } from "zod"
import { createHook, createStore } from "@/state/store"

/*
 * Whether Files is open, and for which conversation's folder: over the Thread on a phone, beside the transcript on a
 * laptop, where Changes goes; the two take turns in that place. Like Changes it has an entry of its own in the
 * browser's history, so Back closes it.
 */

export interface FilesOpen {
  conversation: string
  /** The file being read, if one is: Back goes from it to the tree first. */
  path?: string
  line?: number
}

export const filesOpenStore = createStore<{ open: FilesOpen | null }>({ open: null })
export const useFilesOpen = createHook(filesOpenStore)

const EntrySchema = z.object({ depth: z.number().int().nonnegative().catch(0), makoFiles: z.literal(true).optional().catch(undefined) }).loose()
type Entry = z.infer<typeof EntrySchema>

function entryNow(): Entry {
  return EntrySchema.safeParse(history.state).data ?? { depth: 0 }
}

export function openFiles(open: FilesOpen): void {
  const was = filesOpenStore.get().open
  filesOpenStore.set({ open })
  const entry = entryNow()
  if (was || entry.makoFiles) return
  history.pushState({ ...entry, depth: entry.depth + 1, makoFiles: true }, "")
}

/** Reads a file in the open folder, or goes back to its tree (`path` undefined), without another history entry. */
export function readInFiles(path: string | undefined, line?: number): void {
  const open = filesOpenStore.get().open
  if (open) filesOpenStore.set({ open: { conversation: open.conversation, ...(path && { path, line }) } })
}

export function closeFiles(): void {
  if (entryNow().makoFiles) history.back()
  else filesOpenStore.set({ open: null })
}

/** Follows the history: an entry without the mark closes Files; started once, with the layer. */
export function followFilesHistory(): () => void {
  const popped = () => {
    if (!entryNow().makoFiles && filesOpenStore.get().open) filesOpenStore.set({ open: null })
  }
  window.addEventListener("popstate", popped)
  const entry = entryNow()
  if (entry.makoFiles && !filesOpenStore.get().open) {
    const thread: Entry = { ...entry }
    delete thread.makoFiles
    history.replaceState(thread, "")
  }
  return () => window.removeEventListener("popstate", popped)
}

/** Somewhere else in the app: Files was the last place's. */
export function leftFiles(): void {
  if (filesOpenStore.get().open) filesOpenStore.set({ open: null })
}
