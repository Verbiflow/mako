import { homedir } from "node:os"
import { join } from "node:path"
import { CHATS_FOLDER } from "../contracts/chat-folders.js"

/** The Chats folder, which holds the folders of conversations started in no project. */
export function chatsRoot(): string {
  return join(homedir(), ...CHATS_FOLDER)
}
