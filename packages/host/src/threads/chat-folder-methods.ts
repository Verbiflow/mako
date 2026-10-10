import type { MethodTable } from "../base/methods.js"
import { chatFolders } from "./chat-folders.js"
import type { ChatFolders } from "../contracts/chat-folders.js"

export function declareChatFolderMethods(methods: MethodTable) {
  methods.handle("mako:chat-folders", (paths: string[]): ChatFolders => chatFolders(paths))
}
