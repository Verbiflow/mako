import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { z } from "zod"
import { locateCheckout } from "./checkout-heads.js"
import type { ThreadWorktreeService } from "./thread-worktrees.js"
import { toolText } from "./tool-text.js"
import type { WorkspaceMoves } from "./workspace-moves.js"
import { git } from "./worktree-git.js"
import { checkoutOf, checkoutPattern, projectRoot, projectRecipe } from "./thread-recipe.js"
import { grantedSecrets, readAllowedSecrets } from "./recipe-secrets.js"
import { bringFiles, ignoredEntries, type BringEntry } from "./worktree-carry.js"

type Worktrees = Pick<ThreadWorktreeService, "ofConversation" | "ahead" | "merge" | "remove">

interface Deps {
  cwd(conversationId: string): string | undefined
  worktrees: Worktrees | null
  moves: Pick<WorkspaceMoves, "ask" | "answerFor">
  /** The Thread's worktree went away; windows refresh their list. */
  removed(): void
  recipesRoot?: string
}

export interface WorkspaceStatus {
  editsIn: "this Thread's worktree" | "a worktree made outside Mako" | "the main checkout" | "a folder outside Git"
  folder: string
  branch?: string
  uncommittedFiles?: number
  outsideWorktree?: { folder: string; mainCheckout: string }
  threadWorktree?: { folder: string; branch: string; mainCheckout: string; commitsSinceBranching?: number }
  move?: "asking" | "allowed" | "declined" | "moving"
  ignoredInMain?: { folder: string; paths: string[]; omitted?: number }
}

export interface WorkspaceTools {
  status(conversationId: string): Promise<WorkspaceStatus>
  move(conversationId: string): Promise<string>
  merge(conversationId: string): Promise<string>
  remove(conversationId: string): Promise<string>
  bring(conversationId: string, entries?: BringEntry[]): Promise<string>
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
    return { refused: `This Session already edits in this Thread's worktree, ${current.path}, on ${current.branch}.` }
  const linked = (await locateCheckout(cwd))?.linked
  if (linked) return { refused: `This Session already edits in a worktree made outside Mako, ${linked.path}, of the main checkout ${linked.repoRoot}.` }
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
    if (!worktree) throw new Error("This Thread has no worktree; it edits in the main checkout.")
    return worktree
  }
  return {
    async status(conversationId) {
      const cwd = cwdOf(conversationId)
      const worktree = deps.worktrees?.ofConversation(conversationId)
      const onIt = worktree ? await within(worktree.path, cwd) : false
      const [project, branch, changed, checkout] = await Promise.all([
        git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => ""),
        git(cwd, ["branch", "--show-current"]).catch(() => ""),
        uncommitted(cwd),
        onIt ? null : locateCheckout(cwd),
      ])
      const status: WorkspaceStatus = {
        editsIn: onIt ? "this Thread's worktree" : checkout?.linked ? "a worktree made outside Mako" : project ? "the main checkout" : "a folder outside Git",
        folder: cwd,
      }
      if (checkout?.linked) status.outsideWorktree = { folder: checkout.linked.path, mainCheckout: checkout.linked.repoRoot }
      if (branch) status.branch = branch
      if (project) {
        const main = onIt && worktree ? worktree.repoRoot : checkout?.linked?.repoRoot ?? project
        const ignored = await ignoredEntries(main)
        if (ignored.length) {
          status.ignoredInMain = { folder: main, paths: ignored.slice(0, 200) }
          if (ignored.length > 200) status.ignoredInMain.omitted = ignored.length - 200
        }
      }
      if (changed !== undefined) status.uncommittedFiles = changed
      if (worktree) {
        status.threadWorktree = { folder: worktree.path, branch: worktree.branch, mainCheckout: worktree.repoRoot }
        const ahead = await deps.worktrees?.ahead(worktree.path).catch(() => undefined)
        if (ahead !== undefined) status.threadWorktree.commitsSinceBranching = ahead
      }
      const move = deps.moves.answerFor(conversationId)
      if (move) status.move = move
      return status
    },
    move: (conversationId) => deps.moves.ask(conversationId),
    async bring(conversationId, entries) {
      const cwd = cwdOf(conversationId)
      const checkout = await checkoutOf(cwd)
      const worktree = deps.worktrees?.ofConversation(conversationId)
      if (!worktree || !(await within(worktree.path, checkout))) throw new Error("This Session must edit in this Thread's worktree before bringing files into it. worktree_status says where it edits.")
      const main = await projectRoot(checkout)
      const recipe = await projectRecipe(checkout, deps.recipesRoot)
      const granted = deps.recipesRoot ? grantedSecrets(recipe, await readAllowedSecrets(deps.recipesRoot, checkout)) : []
      const wanted = entries ?? [...(recipe?.carry ?? []), ...granted].map((path) => ({ path }))
      const result = await bringFiles(main, checkout, wanted, granted)
      return toolText({ mainCheckout: main, worktree: checkout, ...result })
    },
    async merge(conversationId) {
      const worktree = threadWorktree(conversationId)
      const merged = await deps.worktrees!.merge(worktree.path)
      return `Merged ${merged.branch} into ${merged.into} in the main checkout, ${worktree.repoRoot}. The branch and this Thread's worktree are still there.`
    },
    async remove(conversationId) {
      const worktree = threadWorktree(conversationId)
      await deps.worktrees!.remove(worktree.path)
      deps.removed()
      return `Removed this Thread's worktree, ${worktree.path}. Its branch, ${worktree.branch}, is kept with everything committed on it.`
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
 * The worktree tools on a conversation's `mako` server. They act
 * on the calling conversation's Thread only. Mako adds no approval of its
 * own to merging or removing: the harness's permission for MCP tools
 * decides, and Mako's checks only keep the work safe.
 */
export function registerWorkspaceTools(server: McpServer, tools: WorkspaceTools, conversationId: () => string): void {
  const none = z.object({}).strict()
  server.registerTool(
    "worktree_status",
    {
      description:
        "Call when you're unsure which checkout your edits land in, and before moving, bringing files, merging or removing. Says whether this Session edits in the main checkout, in this Thread's worktree, or in a worktree made outside Mako. Returns the folder with its branch and uncommitted files, this Thread's worktree with the commits on its branch, the user's answer to a move you asked for, and ignored paths in the originating main checkout. Lists names only; ignored folders are named once.",
      inputSchema: none,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(async () => toolText(await tools.status(conversationId())))
  )
  server.registerTool(
    "worktree_bring",
    {
      description: "Bring ignored files from the originating main checkout into this Thread's existing worktree. Call when the recipe added carry or secrets after the worktree was created, or when this Thread needs a one-off local file or output. Leave entries out to copy the recipe's carry and approved secrets, or name relative paths/patterns without changing the project recipe. Copies by default, cloning large folders on supported volumes; link: true explicitly shares an entry with the main checkout, so writes affect both. Env files are independent copies unless explicitly linked. Existing destination entries stay untouched, including broken links. Credentials require the user's existing App setup grant; no file values are read or returned. Refuses outside paths and Python virtual environments. worktree_status lists the main checkout's ignored paths. Use prepare outputs for dependency folders whose matching inputs Mako should check.",
      inputSchema: z.object({ entries: z.array(z.object({ path: checkoutPattern, link: z.boolean().optional() }).strict()).max(20).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ entries }) => reply(() => tools.bring(conversationId(), entries))
  )
  server.registerTool(
    "worktree_move",
    {
      description:
        "Call when the user asks for this work on its own branch or in a worktree. Asks to move this Session into this Thread's worktree, so your edits stay out of the main checkout. Use this instead of `git worktree add`, a `--worktree` flag or a worktree tool of your own: Mako then shows the branch in the app, brings the conversation and the uncommitted changes along, and offers merging or a pull request afterwards. Returns at once. The user answers in the app, unless the project always allows it; an allowed move happens when your turn ends.",
      inputSchema: none,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => reply(() => tools.move(conversationId()))
  )
  server.registerTool(
    "worktree_merge",
    {
      description:
        "Call when the user asks to merge this Thread's work. Merges the branch of this Thread's worktree into the branch the main checkout has out. Mako merges only when it's safe (everything on the branch committed, the main checkout clean and idle, no conflicts); otherwise it says what's in the way and changes nothing. The branch and the worktree stay.",
      inputSchema: none,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    () => reply(() => tools.merge(conversationId()))
  )
  server.registerTool(
    "worktree_remove",
    {
      description:
        "Call when the user asks to clean up this Thread's worktree. Removes its folder. Refused while anything runs in it or anything in it is uncommitted, so it can't remove the folder you're working in. The branch stays with everything committed on it.",
      inputSchema: none,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    () => reply(() => tools.remove(conversationId()))
  )
}
