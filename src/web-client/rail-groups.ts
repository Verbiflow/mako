import { foldsAsDone } from "@mako/host/contracts/thread-marks"
import type { ShownMarks } from "./thread-marks"
import { projectOf, type WebThread } from "./threads"

/** The chats' group: Threads whose Sessions agree on no project folder. */
export const CHATS_KEY = ""

/**
 * One project's rows, as the desk's rail groups them: its Threads in the list's order, less those Done long enough to
 * fold into its "N done" line (`foldsAsDone`), which are `done`.
 */
export interface RailGroup {
  /** Its project folder, or `CHATS_KEY`. */
  key: string
  name: string
  threads: WebThread[]
  done: WebThread[]
}

/**
 * The list's Threads by project, each group where its first Thread stands in the list (so a project with one waiting on
 * the person comes first, then one at work, then the newest), and the chats last.
 */
export function railGroups(threads: readonly WebThread[], marks: (thread: WebThread) => ShownMarks, now: number): RailGroup[] {
  const groups = new Map<string, RailGroup>()
  for (const thread of threads) {
    const key = thread.projectFolder ?? CHATS_KEY
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { key, name: key === CHATS_KEY ? "Chats" : (projectOf(key) ?? key), threads: [], done: [] }))
    const shown = marks(thread)
    if (foldsAsDone(shown.workStatus ? { status: shown.workStatus, statusAt: shown.workStatusAt || null } : undefined, now)) group.done.push(thread)
    else group.threads.push(thread)
  }
  const chats = groups.get(CHATS_KEY)
  groups.delete(CHATS_KEY)
  return chats ? [...groups.values(), chats] : [...groups.values()]
}
