import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { MERGE_METHODS, PULL_REQUEST_WRITING, type MergeMethod } from "./contracts/git-actions.js"
import { mergePullRequest, openedSentence, openPullRequest, pullRequestReport, type PullRequestDraft } from "./pull-requests.js"
import { toolText } from "./tool-text.js"

interface Deps {
  cwd(conversationId: string): string | undefined
  /** Where this Thread's worktree branch started (`origin/main`), when this Session edits in it. */
  startedFrom(conversationId: string, cwd: string): Promise<string | null>
  /** The branch's pull request changed: cached pull requests are forgotten and windows read GitHub again. */
  changed(): void
}

export interface PullRequestTools {
  status(conversationId: string, logs: boolean): Promise<string>
  open(conversationId: string, draft: PullRequestDraft): Promise<string>
  merge(conversationId: string, method?: MergeMethod): Promise<string>
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** The branch's pull request, for the agent: the same operations as the Git sidebar's. */
export function pullRequestTools(deps: Deps): PullRequestTools {
  const cwdOf = (conversationId: string) => {
    const cwd = deps.cwd(conversationId)
    if (!cwd) throw new Error("Mako isn't running this conversation.")
    return cwd
  }
  return {
    async status(conversationId, logs) {
      const cwd = cwdOf(conversationId)
      return toolText(await pullRequestReport(cwd, { startedFrom: await deps.startedFrom(conversationId, cwd), logs }))
    },
    async open(conversationId, draft) {
      const cwd = cwdOf(conversationId)
      const result = await openPullRequest(cwd, draft, await deps.startedFrom(conversationId, cwd))
      deps.changed()
      const left = result.uncommitted
        ? ` ${plural(result.uncommitted, "file")} with uncommitted changes stayed behind; commit what belongs in it and call again to push.`
        : ""
      return `${openedSentence(result)}.${left}`
    },
    async merge(conversationId, method) {
      const cwd = cwdOf(conversationId)
      const { pull, method: used } = await mergePullRequest(cwd, method)
      deps.changed()
      return `${pull.state === "merged" ? "Merged" : "Asked GitHub to merge"} #${pull.number} into ${pull.base} (${used}). The branch is kept.`
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
 * The pull request tools on a conversation's `mako` server, for the branch
 * the calling conversation edits on. GitHub is reached through the user's
 * own `gh` login, as the Git sidebar reaches it.
 */
export function registerPullRequestTools(server: McpServer, tools: PullRequestTools, conversationId: () => string): void {
  server.registerTool(
    "pull_request_status",
    {
      description:
        "Call before opening, updating or merging this branch's pull request, and when the user asks about its checks or reviews. Reads the pull request of the branch this Session edits on: each check with its state and link, reviews, unresolved review comments by file and line, whether GitHub would merge it, and with logs: true the end of each failed GitHub Actions job's output. With none open, says what opening one would do: the base it targets, the commits it carries, the repository's pull request template, and what's in the way. Changes nothing.",
      inputSchema: z.object({ logs: z.boolean().optional().describe("Include the end of each failed GitHub Actions job's log.") }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ logs }) => reply(() => tools.status(conversationId(), logs ?? false))
  )
  server.registerTool(
    "pull_request_open",
    {
      description:
        `Call when the user asks to open a pull request, or to push to or update the open one. Pushes the branch this Session edits on, never forcing, and opens its pull request; when one is open already it pushes the new commits instead, and edits its title or body only when you pass them. Commit what belongs in it first: uncommitted files stay behind, and the reply says how many. The base defaults to the branch this Thread's worktree started from when origin has it, else the repository's default. Refused on the default branch, with no commits to carry, or when origin has commits the branch lacks. Use this instead of \`gh pr create\`, so the base and the push follow the same rules as the Git sidebar and the user sees it there at once.\n\nWrite the title and body from what the branch does and why, by these rules:\n\n${PULL_REQUEST_WRITING}`,
      inputSchema: z.object({
        title: z.string().max(256).optional().describe("Required for a new pull request; for an open one, only to change it."),
        body: z.string().max(60_000).optional().describe("Markdown; for an open one, only to change it."),
        base: z.string().max(256).optional().describe("The branch to merge into, when not the default."),
        draft: z.boolean().optional().describe("Open it as a draft. Applies only when opening."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (draft) => reply(() => tools.open(conversationId(), draft))
  )
  server.registerTool(
    "pull_request_merge",
    {
      description:
        "Call only when the user asks to merge this branch's pull request on GitHub. Merges it with the method given, or the first the repository allows of squash, merge and rebase. Refused while it conflicts, a check fails or is still running, or changes are requested; the reply says which. The branch is kept, since this Thread's worktree may still be on it.",
      inputSchema: z.object({ method: z.enum(MERGE_METHODS).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ method }) => reply(() => tools.merge(conversationId(), method))
  )
}
