/**
 * Chats: Threads started without a project. Each one gets a folder of its
 * own under `~/Mako/Chats`, made at its first send, and every Session of the
 * Thread works there. The rail files them all under one "Chats" group until
 * a folder becomes a Git repository, when it's a project like any other.
 */
export const CHATS_FOLDER = ["Mako", "Chats"] as const

export interface ChatFolders {
  /** The Chats folder itself, absolute. */
  root: string
  /** Of the chat folders asked about, those that are Git repositories now. */
  projects: string[]
}

/**
 * The chat's own folder holding `path`: "" for the Chats folder itself,
 * undefined for anything outside it.
 */
export function chatFolderOf(path: string | undefined, root: string): string | undefined {
  if (!root || !path) return undefined
  const trimmed = path.replace(/\/+$/, "")
  if (trimmed === root) return ""
  if (!trimmed.startsWith(`${root}/`)) return undefined
  const name = trimmed.slice(root.length + 1).split("/")[0]
  return name ? `${root}/${name}` : ""
}

/** A new chat's folder name: the local date it started, then a short id, so a listing sorts by age. */
export function chatFolderName(at: Date, id: string): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${id}`
}
