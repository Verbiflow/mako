import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { z } from "zod"
import type { ThreadWorktreeService } from "./thread-worktrees.js"
import type { WorkspaceMoves } from "./workspace-moves.js"
import { git } from "./worktree-git.js"

type Worktrees = Pick<ThreadWorktreeService, "ofConversation" | "ahead" | "merge" | "remove">

interface Deps {
  cwd(conversationId: string): string | undefined
  worktrees: Worktrees | null
  moves: Pick<WorkspaceMoves, "ask" | "answerFor">
  /** The Thread's worktree went away; windows refresh their list. */
  removed(): void
}

export interface WorkspaceStatus {
  makesChangesIn: "its own branch" | "the project folder" | "a folder outside Git"
  folder: string
  branch?: string
  uncommittedFiles?: number
  threadBranch?: { branch: string; worktree: string; project: string; commitsSinceBranching?: number }
  move?: "asking" | "allowed" | "declined" | "moving"
}

export interface WorkspaceTools {
  status(conversationId: string): Promise<WorkspaceStatus>
  move(conversationId: string): Promise<string>
  merge(conversationId: string): Promise<string>
  remove(conversationId: string): Promise<string>
}

async function within(folder: string, path: string): Promise<boolean> {
  const inside = relative(await realpath(folder).catch(() => folder), await realpath(path).catch(() => path))
  return !inside.startsWith("..") && !isAbsolute(inside)
}

async function uncommitted(cwd: string): Promise<number | undefined> {
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => undefined)
  return status === undefined ? undefined : status.split("\n").filter(Boolean).length
}

/** The same folder's project root and uncommitted files, for a move's request. */
export async function moveablePlace(worktrees: Worktrees | null, conversationId: string, cwd: string) {
  if (!worktrees) return { refused: "Worktrees need the Thread store, which didn't open." }
  const current = worktrees.ofConversation(conversationId)
  if (current && (await within(current.path, cwd)))
    return { refused: `This Session already works on its own branch, ${current.branch}, in ${current.path}.` }
  const project = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")
  if (!project) return { refused: "This folder isn't in a Git repository, so there's no branch to move onto." }
  return current
    ? { project, joins: current.branch, changed: 0 }
    : { project, changed: (await uncommitted(project)) ?? 0 }
}

export function workspaceTools(deps: Deps): WorkspaceTools {
  const cwdOf = (conversationId: string) => {
    const cwd = deps.cwd(conversationId)
    if (!cwd) throw new Error("Mako isn't running this conversation.")
    return cwd
  }
  const threadWorktree = (conversationId: string) => {
    const worktree = deps.worktrees?.ofConversation(conversationId)
    if (!worktree) throw new Error("This Thread has no branch of its own; it makes changes in the project folder.")
    return worktree
  }
  return {
    async status(conversationId) {
      const cwd = cwdOf(conversationId)
      const worktree = deps.worktrees?.ofConversation(conversationId)
      const onIt = worktree ? await within(worktree.path, cwd) : false
      const [project, branch, changed] = await Promise.all([
        git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => ""),
        git(cwd, ["branch", "--show-current"]).catch(() => ""),
        uncommitted(cwd),
      ])
      const status: WorkspaceStatus = {
        makesChangesIn: onIt ? "its own branch" : project ? "the project folder" : "a folder outside Git",
        folder: cwd,
      }
      if (branch) status.branch = branch
      if (changed !== undefined) status.uncommittedFiles = changed
      if (worktree) {
        status.threadBranch = { branch: worktree.branch, worktree: worktree.path, project: worktree.repoRoot }
        const ahead = await deps.worktrees?.ahead(worktree.path).catch(() => undefined)
        if (ahead !== undefined) status.threadBranch.commitsSinceBranching = ahead
      }
      const move = deps.moves.answerFor(conversationId)
      if (move) status.move = move
      return status
    },
    move: (conversationId) => deps.moves.ask(conversationId),
    async merge(conversationId) {
      const worktree = threadWorktree(conversationId)
      const merged = await deps.worktrees!.merge(worktree.path)
      return `Merged ${merged.branch} into ${merged.into} in ${worktree.repoRoot}. The branch and its worktree are still there.`
    },
    async remove(conversationId) {
      const worktree = threadWorktree(conversationId)
      await deps.worktrees!.remove(worktree.path)
      deps.removed()
      return `Removed the worktree at ${worktree.path}. Its branch, ${worktree.branch}, is kept with everything committed on it.`
    },
  }
}

async function reply(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] }
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
  }
}

/**
 * The workspace tools beside `js` on a conversation's MCP server. They act
 * on the calling conversation's Thread only. Mako adds no approval of its
 * own to merging or removing: the harness's permission for MCP tools
 * decides, and Mako's checks only keep the work safe.
 */
export function registerWorkspaceTools(server: McpServer, tools: WorkspaceTools, conversationId: () => string): void {
  const none = z.object({}).strict()
  server.registerTool(
    "workspace_status",
    {
      description:
        "Where this Session makes changes: the project folder itself, or its Thread's own branch (a Git worktree Mako made). Returns the folder, branch, uncommitted files, the Thread's branch and its commits, and the answer to a move you asked for.",
      inputSchema: none,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(async () => JSON.stringify(await tools.status(conversationId()), null, 2))
  )
  server.registerTool(
    "workspace_move",
    {
      description:
        "Ask to go on on this Thread's own branch: a Git worktree with its own checkout, so your edits stay out of the user's project folder. Use this instead of `git worktree add`, a `--worktree` flag or a worktree tool of your own: Mako then shows the branch in the app, brings the conversation and the uncommitted changes along, and offers merging or a pull request afterwards. Returns at once. The user answers in the app, unless the project always allows it; an allowed move happens when your turn ends.",
      inputSchema: none,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => reply(() => tools.move(conversationId()))
  )
  server.registerTool(
    "workspace_merge",
    {
      description:
        "Merge this Thread's branch into the branch the project folder has out. Mako merges only when it's safe (everything on the branch committed, the project folder clean and idle, no conflicts); otherwise it says what's in the way and changes nothing. The branch and its worktree stay.",
      inputSchema: none,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    () => reply(() => tools.merge(conversationId()))
  )
  server.registerTool(
    "workspace_remove",
    {
      description:
        "Remove this Thread's worktree folder. Refused while anything runs in it or anything in it is uncommitted, so it can't remove the folder you're working in. The branch stays with everything committed on it.",
      inputSchema: none,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    () => reply(() => tools.remove(conversationId()))
  )
}
