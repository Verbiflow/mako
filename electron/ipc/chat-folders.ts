import type { MethodTable } from "../host-methods.js"
import { chatFolders } from "../chat-folders.js"
import type { ChatFolders } from "@mako/host/contracts/chat-folders"

export function installChatFoldersIpc(methods: MethodTable) {
  methods.handle("mako:chat-folders", (paths: string[]): ChatFolders => chatFolders(paths))
}
