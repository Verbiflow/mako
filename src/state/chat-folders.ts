import { chatFolderOf } from "../../electron/contracts/chat-folders.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { acpStore } from "@/state/acp-state"
import { createHook, createStore } from "@/state/store"
import { threadsStore } from "@/state/thread-store"

/**
 * The Chats folder, and which chat folders are Git repositories now. A chat
 * folder files under the rail's one "Chats" group until it becomes a
 * repository, then it's a project of its own, in place: same folder, same
 * Thread. Mako looks when a chat first shows up, when it's opened, and when
 * a turn in it ends, which is when an agent may have run `git init`; there's
 * no watcher.
 */
interface ChatFoldersState {
  /** "" until the host has answered. */
  root: string
  projects: ReadonlySet<string>
}

export const chatFoldersStore = createStore<ChatFoldersState>({ root: "", projects: new Set() })
export const useChatFolders = createHook(chatFoldersStore)

/** Where a path files in the rail: the Chats folder for a chat that isn't a project, else nothing. */
export function chatGroupOf(path: string, state: ChatFoldersState = chatFoldersStore.get()): string | undefined {
  const folder = chatFolderOf(path, state.root)
  return folder && !state.projects.has(folder) ? state.root : undefined
}

export async function refreshChatFolders(paths: readonly string[] = []): Promise<void> {
  if (!hasBridge()) return
  const { root, projects } = await getMako().chatFolders([...paths])
  const asked = new Set(paths.map((path) => chatFolderOf(path, root)).filter(Boolean))
  chatFoldersStore.set((state) => {
    const next = new Set([...state.projects].filter((folder) => !asked.has(folder)))
    for (const folder of projects) next.add(folder)
    const same = state.root === root && next.size === state.projects.size && [...next].every((folder) => state.projects.has(folder))
    return same ? {} : { root, projects: next }
  })
}

let following = false

/** Keeps `chatFoldersStore` current for the life of the window. */
export function followChatFolders(): void {
  if (following) return
  following = true
  const checked = new Set<string>()
  let viewing: string | undefined
  let running = new Set<string>()
  const check = (paths: string[]) => {
    if (paths.length) void refreshChatFolders(paths).catch(() => {})
  }
  const folderOf = (path: string | undefined) => (path ? chatFolderOf(path, chatFoldersStore.get().root) : undefined)
  const scan = () => {
    const { threads, viewing: open } = threadsStore.get()
    const fresh: string[] = []
    for (const ref of threads) {
      const folder = folderOf(ref.cwd)
      if (folder && !checked.has(folder)) {
        checked.add(folder)
        fresh.push(folder)
      }
    }
    const opened = folderOf(open?.ref.cwd)
    if (opened && opened !== viewing && !fresh.includes(opened)) fresh.push(opened)
    viewing = opened
    check(fresh)
  }
  threadsStore.subscribe(scan)
  acpStore.subscribe(() => {
    const now = new Set<string>()
    for (const conversation of Object.values(acpStore.get().conversations)) {
      if (conversation.kind !== "live" || conversation.session.status !== "running") continue
      const folder = folderOf(conversation.session.cwd)
      if (folder) now.add(folder)
    }
    check([...running].filter((folder) => !now.has(folder)))
    running = now
  })
  // Chats are recognised by the root the host names, so the list is read again once it's known.
  void refreshChatFolders().then(scan, () => {})
}
