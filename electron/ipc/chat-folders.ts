import { registerIpc } from "./register.js"
import { chatFolders } from "../chat-folders.js"
import type { ChatFolders } from "../contracts/chat-folders.js"

export function installChatFoldersIpc() {
  registerIpc("mako:chat-folders", (_event, paths: string[]): ChatFolders => chatFolders(paths))
}
