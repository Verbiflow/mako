import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CHATS_FOLDER, chatFolderName, chatFolderOf, type ChatFolders } from "./contracts/chat-folders.js"

export function chatsRoot(): string {
  return join(homedir(), ...CHATS_FOLDER)
}

export function ensureChatsRoot(): string {
  const root = chatsRoot()
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * A folder that stands for no project: the Chats folder itself, or the disk
 * root an app opened from the Dock or Finder was given as its working
 * directory. A new conversation asked to start in one starts in a chat
 * folder of its own instead.
 */
export function standsForNoProject(cwd: string): boolean {
  return !cwd || cwd === "/" || cwd === chatsRoot()
}

export function newChatFolder(at = new Date()): string {
  const root = ensureChatsRoot()
  for (;;) {
    const folder = join(root, chatFolderName(at, randomBytes(3).toString("hex")))
    if (existsSync(folder)) continue
    mkdirSync(folder)
    return folder
  }
}

/** Gives back a chat folder nothing was written to; one with anything in it stays. */
export function discardChatFolder(folder: string): void {
  try {
    rmdirSync(folder)
  } catch {
    // Not empty, or already gone.
  }
}

/** The Chats folder, and which of `paths` are chat folders that hold a Git repository now. */
export function chatFolders(paths: readonly string[]): ChatFolders {
  const root = ensureChatsRoot()
  const projects = new Set<string>()
  for (const path of paths) {
    const folder = chatFolderOf(path, root)
    if (folder && existsSync(join(folder, ".git"))) projects.add(folder)
  }
  return { root, projects: [...projects] }
}
