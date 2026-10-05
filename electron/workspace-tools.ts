import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { realpath } from "node:fs/promises"
import { basename, isAbsolute, relative } from "node:path"
import { z } from "zod"
import { locateCheckout } from "./checkout-heads.js"
import { discoverRepositories } from "./repository-discovery.js"
import type { ThreadCheckout, ThreadWorktreeService } from "./thread-worktrees.js"
import { toolText } from "./tool-text.js"
import type { WorkspaceMoves } from "./workspace-moves.js"
import { git } from "@mako/git"
import { checkoutPattern, projectRoot, projectRecipe } from "./thread-recipe.js"
import { bringFiles, ignoredEntries, type BringEntry } from "./worktree-carry.js"
import { gitActionPrompt } from "./contracts/git-actions.js"
import type { ThreadWorktree, WorktreeBranchPull } from "./contracts/thread-worktrees.js"

type Worktrees = Pick<ThreadWorktreeService, "threadCheckout" | "ahead" | "merge" | "remove" | "review" | "update" | "summary">

interface Deps {
  cwd(conversationId: string): string | undefined
  worktrees: Worktrees | null
  moves: Pick<WorkspaceMoves, "ask" | "answerFor">
  /** The Thread's worktree or its branch changed, or the worktree went away; windows read them again. */
  changed(): void
  /** A repository's recent pull requests, for the worktree's own. */
  pullsOf?: (repoRoot: string) => Promise<WorktreeBranchPull[] | null>
  recipesRoot?: string
}

interface BranchState {
  commitsSinceBranching?: number
  startedFrom?: string
  behind?: { from: string; commits: number }
  landedIn?: string
  pullRequest?: { number: number; state: WorktreeBranchPull["state"]; url: string; checks?: NonNullable<WorktreeBranchPull["checks"]> }
}

export interface WorkspaceStatus {
  editsIn: "this Thread's worktree" | "a worktree made outside Mako" | "the main checkout" | "a folder outside Git"
  folder: string
  branch?: string
  uncommittedFiles?: number
  outsideWorktree?: { folder: string; mainCheckout: string }
  threadWorktree?: BranchState & {
    folder: string
    branch: string
    mainCheckout: string
    /** A project folder of several repositories: each one's worktree inside `folder`, and how its branch stands. */
    repositories?: (BranchState & { folder: string; mainCheckout: string })[]
  }
  move?: "asking" | "allowed" | "declined" | "moving"
  ignoredInMain?: { folder: string; paths: string[]; omitted?: number }
}

export interface WorkspaceTools {
  status(conversationId: string): Promise<WorkspaceStatus>
  move(conversationId: string): Promise<string>
  update(conversationId: string): Promise<string>
  merge(conversationId: string): Promise<string>
  remove(conversationId: string): Promise<string>
  bring(conversationId: string, entries?: BringEntry[]): Promise<string>
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** Whether `path` is `folder` or inside it, symlinks resolved. */
export async function within(folder: string, path: string): Promise<boolean> {
  const inside = relative(await realpath(folder).catch(() => folder), await realpath(path).catch(() => path))
  return !inside.startsWith("..") && !isAbsolute(inside)
}

async function uncommitted(cwd: string): Promise<number | undefined> {
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => undefined)
  return status === undefined ? undefined : status.split("\n").filter(Boolean).length
}

/** Uncommitted files across the repositories a folder outside Git holds; undefined when it holds none. */
async function uncommittedIn(folder: string): Promise<number | undefined> {
  const { roots } = await discoverRepositories(folder)
  if (!roots.length) return undefined
  const counts = await Promise.all(roots.map((root) => uncommitted(root)))
  return counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

/** The same folder's project root and uncommitted files, for a move's request. */
export async function moveablePlace(worktrees: Worktrees | null, conversationId: string, cwd: string) {
  if (!worktrees) return { refused: "Worktrees need the Thread store, which didn't open." }
  const current = worktrees.threadCheckout(conversationId)
  if (current && (await within(current.path, cwd)))
    return { refused: `This Session already edits in this Thread's worktree, ${current.path}, on ${current.branch}.` }
  const linked = (await locateCheckout(cwd))?.linked
  if (linked) return { refused: `This Session already edits in a worktree made outside Mako, ${linked.path}, of the main checkout ${linked.repoRoot}.` }
  const repository = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")
  // A project folder holding several repositories moves onto one branch in every one.
  const changed = repository ? await uncommitted(repository) : await uncommittedIn(cwd)
  const project = repository || (changed === undefined ? "" : await realpath(cwd).catch(() => cwd))
  if (!project) return { refused: "This folder isn't in a Git repository and holds none, so there's no branch to move onto." }
  return current
    ? { project, joins: current.branch, changed: 0 }
    : { project, changed: changed ?? 0 }
}

export function workspaceTools(deps: Deps): WorkspaceTools {
  const cwdOf = (conversationId: string) => {
    const cwd = deps.cwd(conversationId)
    if (!cwd) throw new Error("Mako isn't running this conversation.")
    return cwd
  }
  const threadCheckout = (conversationId: string) => {
    const checkout = deps.worktrees?.threadCheckout(conversationId)
    if (!checkout) throw new Error("This Thread has no worktree; it edits in the main checkout.")
    return checkout
  }
  const branchState = async (path: string): Promise<BranchState> => {
    const state: BranchState = {}
    const [ahead, summary] = await Promise.all([
      deps.worktrees?.ahead(path).catch(() => undefined),
      deps.worktrees?.summary(path, deps.pullsOf).catch(() => undefined),
    ])
    if (ahead !== undefined) state.commitsSinceBranching = ahead
    if (summary?.startedFrom) state.startedFrom = summary.startedFrom
    if (summary?.behind?.commits) state.behind = summary.behind
    if (summary?.landing.kind === "merged") state.landedIn = summary.landing.into
    if (summary?.pull) {
      const { number, state: pullState, url, checks } = summary.pull
      state.pullRequest = checks ? { number, state: pullState, url, checks } : { number, state: pullState, url }
    }
    return state
  }
  /** The repository a project checkout's worktree holds, as a person names it: its folder inside the checkout. */
  const named = (checkout: ThreadCheckout, worktree: ThreadWorktree) => relative(checkout.path, worktree.path) || basename(worktree.path)
  return {
    async status(conversationId) {
      const cwd = cwdOf(conversationId)
      const current = deps.worktrees?.threadCheckout(conversationId)
      const onIt = current ? await within(current.path, cwd) : false
      const several = current && current.path !== current.worktrees[0]?.path ? current : undefined
      const [project, branch, changed, checkout] = await Promise.all([
        git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => ""),
        git(cwd, ["branch", "--show-current"]).catch(() => ""),
        uncommitted(cwd).then((count) => count ?? uncommittedIn(cwd)),
        onIt ? null : locateCheckout(cwd),
      ])
      const status: WorkspaceStatus = {
        editsIn: onIt ? "this Thread's worktree" : checkout?.linked ? "a worktree made outside Mako" : project ? "the main checkout" : "a folder outside Git",
        folder: cwd,
      }
      if (checkout?.linked) status.outsideWorktree = { folder: checkout.linked.path, mainCheckout: checkout.linked.repoRoot }
      if (branch) status.branch = branch
      const main = onIt && current ? current.project : project ? checkout?.linked?.repoRoot ?? project : ""
      if (main) {
        const ignored = await ignoredEntries(main).catch((): string[] => [])
        if (ignored.length) {
          status.ignoredInMain = { folder: main, paths: ignored.slice(0, 200) }
          if (ignored.length > 200) status.ignoredInMain.omitted = ignored.length - 200
        }
      }
      if (changed !== undefined) status.uncommittedFiles = changed
      if (several) {
        status.threadWorktree = {
          folder: several.path,
          branch: several.branch,
          mainCheckout: several.project,
          repositories: await Promise.all(several.worktrees.map(async (worktree) => ({ folder: worktree.path, mainCheckout: worktree.repoRoot, ...await branchState(worktree.path) }))),
        }
      } else if (current?.worktrees[0]) {
        const [worktree] = current.worktrees
        status.threadWorktree = { folder: worktree.path, branch: worktree.branch, mainCheckout: worktree.repoRoot, ...await branchState(worktree.path) }
      }
      const move = deps.moves.answerFor(conversationId)
      if (move) status.move = move
      return status
    },
    move: (conversationId) => deps.moves.ask(conversationId),
    async bring(conversationId, entries) {
      const cwd = cwdOf(conversationId)
      const current = deps.worktrees?.threadCheckout(conversationId)
      if (!current || !(await within(current.path, cwd))) throw new Error("This Session must edit in this Thread's worktree before bringing files into it. worktree_status says where it edits.")
      const checkout = current.path
      const main = await projectRoot(checkout)
      const recipe = await projectRecipe(checkout, deps.recipesRoot)
      const wanted = entries ?? recipe?.carry ?? []
      const result = await bringFiles(main, checkout, wanted)
      return toolText({ mainCheckout: main, worktree: checkout, ...result })
    },
    async update(conversationId) {
      const checkout = threadCheckout(conversationId)
      const lines: string[] = []
      for (const worktree of checkout.worktrees) {
        const where = checkout.worktrees.length > 1 ? `${named(checkout, worktree)}: ` : ""
        const result = await deps.worktrees!.update(worktree.path)
        if (result.kind === "current") {
          lines.push(`${where}${worktree.branch} already has everything in ${result.from}.`)
          continue
        }
        deps.changed()
        if (result.kind === "updated") {
          lines.push(`${where}Merged ${plural(result.commits, "commit")} from ${result.from} into ${worktree.branch}. Run the checks before going on.`)
          continue
        }
        return toolText({
          ...(lines.length ? { done: lines } : {}),
          stopped: `The merge is in progress in ${worktree.path}.`,
          conflicts: result.files,
          next: `${gitActionPrompt({ kind: "resolve", branch: worktree.branch, from: result.from, files: result.files })} \`git merge --abort\` puts the branch back as it was.${checkout.worktrees.length > 1 ? " Call worktree_update again afterwards for the other repositories." : ""}`,
        })
      }
      return lines.join("\n")
    },
    async merge(conversationId) {
      const checkout = threadCheckout(conversationId)
      if (checkout.worktrees.length === 1) {
        const [worktree] = checkout.worktrees
        const merged = await deps.worktrees!.merge(worktree!.path)
        deps.changed()
        return `Merged ${merged.branch} into ${merged.into} in the main checkout, ${worktree!.repoRoot}. The branch and this Thread's worktree are still there.`
      }
      // Every repository with work is checked before any is merged, so a refusal leaves them all as they were.
      const reviews = await Promise.all(checkout.worktrees.map(async (worktree) => ({ worktree, review: await deps.worktrees!.review(worktree.path) })))
      const working = reviews.filter(({ review }) => review.commits > 0)
      if (!working.length) throw new Error(`Nothing is committed on ${checkout.branch} in any of the project's repositories.`)
      const refused = working.flatMap(({ worktree, review }) => review.merge.ok ? [] : [`${named(checkout, worktree)}: ${review.merge.reason}`])
      if (refused.length) throw new Error(`Nothing was merged. ${refused.join(" ")}`)
      const merged: string[] = []
      for (const { worktree } of working) {
        const done = await deps.worktrees!.merge(worktree.path)
        merged.push(`${named(checkout, worktree)} into ${done.into}`)
      }
      deps.changed()
      return `Merged ${checkout.branch} in ${merged.join(", ")}. The branch and this Thread's worktree are still there.`
    },
    async remove(conversationId) {
      const checkout = threadCheckout(conversationId)
      await deps.worktrees!.remove(checkout.worktrees[0]!.path)
      deps.changed()
      return `Removed this Thread's worktree, ${checkout.path}. Its branch, ${checkout.branch}, is kept with everything committed on it${checkout.worktrees.length > 1 ? " in each repository" : ""}.`
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
        "Call when you're unsure which checkout your edits land in, and before moving, bringing files, updating, merging or removing. Says whether this Session edits in the main checkout, in this Thread's worktree, or in a worktree made outside Mako. Returns the folder with its branch and uncommitted files; this Thread's worktree with the commits on its branch, where it started, how far behind the branch new Threads start from it is, whether its work has landed in the main checkout's branch, and its pull request with one word for its checks (for a project folder holding several repositories, the worktree holds one per repository on the same branch, each listed with these); the user's answer to a move you asked for; and ignored paths in the originating main checkout. Lists names only; ignored folders are named once.",
      inputSchema: none,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(async () => toolText(await tools.status(conversationId())))
  )
  server.registerTool(
    "worktree_bring",
    {
      description: "Bring ignored files from the originating main checkout into this Thread's existing worktree. Call when the recipe's carry changed after the worktree was created, when this Thread needs a one-off local file or output, or to make a linked entry this worktree's own before changing it. Leave entries out to bring the recipe's carry as it says, or name relative paths or patterns without changing the recipe. Copies by default, cloning large folders on supported volumes; link: true shares an entry with the main checkout, so a write there changes both. Copying an entry that's linked here makes it this worktree's own, keeping what was made in it here; other existing entries stay untouched. No file values are read or returned. Refuses outside paths and Python virtual environments. worktree_status lists the main checkout's ignored paths. Use prepare outputs for dependency folders whose matching inputs Mako should check.",
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
    "worktree_update",
    {
      description:
        "Call when the user asks to update this branch from main, or before opening a pull request when worktree_status says the branch is behind. Fetches, then merges what the branch new Threads start from has (main, or origin/main when only it moved) into this Thread's worktree branch; the same Update the user has in the Git sidebar. Never rebases or force-pushes. Refused with uncommitted changes to tracked files, during another merge or rebase, or off the branch. When it stops on conflicts, the merge stays in progress and the result lists the files and how to finish it.",
      inputSchema: none,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () => reply(() => tools.update(conversationId()))
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
