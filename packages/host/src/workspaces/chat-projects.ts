import { existsSync } from "node:fs"
import { lstat, realpath, rename, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { chatsRoot } from "../base/chats.js"
import { findExecutable } from "../base/executable.js"
import { hostCommand } from "../base/host-command.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { chatFolderOf } from "../contracts/chat-folders.js"
import type { WorkspaceConversations } from "./conversations.js"
import { expandPath } from "./project-folders.js"

/** A chat to turn into a project: its folder under `~/Mako/Chats`, and where the project goes (`~/…` or `/…`). */
export const ChatProjectRequestSchema = z.lazy(() => z.object({ folder: z.string().min(1).max(4096), to: z.string().min(1).max(4096) }).strict())
export type ChatProjectRequest = z.infer<typeof ChatProjectRequestSchema>

const holds = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`)

/**
 * Turns a chat (a Thread started without a project, in a folder of its own under `~/Mako/Chats`) into a project: its
 * folder moves to `to`, becomes a Git repository, and every conversation in it goes on there under its own native
 * session (`relocate`, then `resumeMoved`), so the Thread is the same Thread, now filed under its project. Nothing
 * moves unless every conversation there can move now; a move that doesn't resume puts everything back as it was.
 */
export async function makeChatProject(
  live: Pick<WorkspaceConversations, "summaries" | "relocation" | "relocate" | "resumeMoved">,
  request: ChatProjectRequest,
  home = homedir(),
): Promise<{ path: string }> {
  const { folder, to } = ChatProjectRequestSchema.parse(request)
  const root = chatsRoot()
  const chat = chatFolderOf(folder, await realpath(root).catch(() => root)) ?? chatFolderOf(folder, root)
  if (!chat || chat !== folder.replace(/\/+$/, "")) throw new Error("Only a chat's own folder, under Mako's Chats folder, becomes a project this way.")
  if (!(await stat(chat).then((found) => found.isDirectory(), () => false))) throw new Error("The chat's folder isn't there anymore.")

  const typed = to.trim()
  if (!typed.startsWith("/") && !typed.startsWith("~/")) throw new Error("Write the project's whole path, starting with ~/ or /.")
  if (typed.split(/[\\/]/).some((part) => part === ".." || part === ".")) throw new Error("Write the project's whole path, without . or .. in it.")
  const path = expandPath(typed.replace(/\/+$/, ""), home)
  if (basename(path).startsWith(".")) throw new Error("A project's folder name can't start with a dot.")
  if (holds(root, path)) throw new Error("A project goes outside the Chats folder.")
  if (await lstat(path).then(() => true, () => false)) throw new Error(`${path} already exists. Pick another name.`)
  const parent = await realpath(dirname(path)).catch(() => undefined)
  if (!parent || !(await stat(parent).then((found) => found.isDirectory(), () => false))) throw new Error(`${dirname(path)} isn't a folder on this Mac.`)
  const target = join(parent, basename(path))

  // Every conversation working in the chat's folder goes with it, or nothing moves.
  const sessions = live.summaries().map(({ session }) => session).filter((session) => holds(chat, session.cwd))
  const staying = sessions.flatMap((session) => {
    const relocation = live.relocation(session.id)
    return relocation.kind === "now" ? [] : [`“${session.title || "Untitled conversation"}” ${relocation.reason}`]
  })
  if (staying.length) throw new Error(`It can't move yet: ${staying.join("; ")}.`)

  const moved: Array<{ id: string; from: string }> = []
  const putBack = async () => {
    for (const { id, from } of moved.reverse()) await live.relocate(id, from).catch(() => undefined)
  }
  for (const session of sessions) {
    const from = await live.relocate(session.id, `${target}${session.cwd.slice(chat.length)}`)
    if (from === undefined) {
      await putBack()
      throw new Error(`“${session.title || "Untitled conversation"}” couldn't move; nothing moved.`)
    }
    moved.push({ id: session.id, from })
  }
  try {
    await rename(chat, target)
  } catch (error) {
    await putBack()
    const code = error instanceof Error && "code" in error ? String(error.code) : ""
    throw new Error(code === "EXDEV" ? "Pick a place on the same disk as your home folder; the chat moves, it isn't copied." : `The folder didn't move: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!existsSync(join(target, ".git"))) {
    const git = (await findExecutable("git")) ?? "git"
    await hostCommand(git, ["init", "--quiet"], { cwd: target, timeout: 20_000 }).catch((error: Error) => hostWarn("projects", "a chat's new project wasn't made a repository", { error: error.message }))
  }
  for (const { id, from } of moved) {
    const why = await live.resumeMoved(id, from)
    if (why === undefined) continue
    // One didn't go on there and is back in the chat's folder: so is everything else.
    await rename(target, chat).catch(() => undefined)
    await putBack()
    throw new Error(`The chat stayed where it was: ${why}`)
  }
  hostLog("projects", "a chat became a project", { conversations: sessions.length })
  return { path: target }
}
