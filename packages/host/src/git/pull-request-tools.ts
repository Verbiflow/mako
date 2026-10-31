import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { basename, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { MERGE_METHODS, PULL_REQUEST_WRITING, type MergeMethod } from "../contracts/git-actions.js"
import { mergePullRequest, openedSentence, openPullRequest, pullRequestReport, type PersonOf, type PullRequestDraft, type PullRequestReport } from "./pull-requests.js"
import { authorWords, MAKO_GITHUB_APP } from "../contracts/github-person.js"
import { toolText } from "../base/tool-text.js"
import type { Git } from "@mako/git"

/** A repository the calling Session can reach: its name in the project folder, its root, and where its worktree branch started. */
export interface ReachableRepository {
  /** Its folder relative to the project folder (`api`, `services/web`); the repository's own folder name when it stands alone. */
  name: string
  root: string
  /** Where this Thread's worktree branch started (`origin/main`); null outside one of Mako's worktrees. */
  startedFrom: string | null
}

/**
 * Where the calling Session edits, as the pull request tools see it: one
 * repository, or a project folder holding several, each with a pull
 * request of its own.
 */
export interface RepositoryPlace {
  /** The repository, or the project folder holding the repositories. */
  folder: string
  repositories: ReachableRepository[]
  /** The repository the Session's folder is inside, when it's inside one. */
  here?: ReachableRepository
}

interface Deps {
  git: Git
  /** Where the conversation edits; throws when Mako isn't running it or the folder holds no repository. */
  place(conversationId: string): Promise<RepositoryPlace>
  /** A pull request changed: cached pull requests are forgotten and windows read GitHub again. */
  changed(): void
  /** On a cloud machine: whether its pull requests go as its person, asked before each write; undefined elsewhere. */
  person?: PersonOf
}

export interface PullRequestTools {
  status(conversationId: string, options?: { logs?: boolean; repository?: string }): Promise<string>
  open(conversationId: string, draft: PullRequestDraft & { repository?: string }): Promise<string>
  merge(conversationId: string, options?: { method?: MergeMethod; repository?: string; as?: "app" }): Promise<string>
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** The repository `wanted` names: its name in the project, its folder from the project or as an absolute path, or its folder's own name when only one has it. */
function named(place: RepositoryPlace, wanted: string): ReachableRepository {
  const path = resolve(place.folder, wanted.trim())
  const name = relative(place.folder, path)
  const found = place.repositories.find((repository) => repository.name === name || repository.root === path)
  if (found) return found
  const byFolder = name.includes(sep) ? [] : place.repositories.filter((repository) => basename(repository.root) === name)
  if (byFolder.length === 1) return byFolder[0]!
  const names = place.repositories.map((repository) => repository.name).join(", ")
  throw new Error(`${place.folder} has no repository named ${JSON.stringify(wanted)}. Pass one of: ${names}.`)
}

/** The one repository a call means: the one named, the one the Session's folder is inside, or the only one. Undefined in a project folder of several. */
function meant(place: RepositoryPlace, repository: string | undefined): ReachableRepository | undefined {
  if (repository !== undefined) return named(place, repository)
  return place.here ?? (place.repositories.length === 1 ? place.repositories[0] : undefined)
}

/** One line for where a repository's pull request stands, for a refusal that lists each of a project's repositories. */
function standing(report: PullRequestReport): string {
  if (report.github) return report.github
  if (!report.branch) return "not on a branch"
  const pull = report.pullRequest
  if (pull) {
    const unpushed = pull.unpushedCommits ? `, ${plural(pull.unpushedCommits, "commit")} to push` : ""
    return `#${pull.number} is open${unpushed}; ${pull.merge.startsWith("GitHub would merge it now") ? "GitHub would merge it now" : pull.merge.toLowerCase()}`
  }
  const opening = report.opening
  if (!opening) return `${report.branch} has no pull request`
  if (opening.blocked) return opening.blocked
  return `${plural(opening.commits.length + (opening.moreCommits ?? 0), "commit")} to carry into ${opening.base}`
}

/** The pull request tools for the calling conversation: the same operations as the Git sidebar's, one repository at a time. */
export function pullRequestTools(deps: Deps): PullRequestTools {
  const report = (repository: ReachableRepository, logs = false) => pullRequestReport(deps.git, repository.root, { startedFrom: repository.startedFrom, logs })
  /**
   * In a project folder of several repositories with none named: the one
   * that `wanted` fits. Several or none is refused with where each one
   * stands, before anything is pushed or merged.
   */
  const onlyOne = async (place: RepositoryPlace, wanted: "work" | "pull"): Promise<ReachableRepository> => {
    const reports = await Promise.all(place.repositories.map(async (repository) => ({ repository, report: await report(repository) })))
    const fits = reports.filter(({ report: read }) => wanted === "pull"
      ? read.pullRequest
      : read.pullRequest?.unpushedCommits || (read.opening && !read.opening.blocked))
    if (fits.length === 1) return fits[0]!.repository
    const lines = reports.map(({ repository, report: read }) => `- ${repository.name}: ${standing(read)}`).join("\n")
    if (wanted === "work") {
      throw new Error(fits.length
        ? `Several of this project's repositories have work to open, and each takes its own pull request. Nothing was pushed. Call pull_request_open once for each, passing repository and a title and body for that repository's own change:\n${lines}`
        : `None of this project's repositories has work to open a pull request for:\n${lines}`)
    }
    throw new Error(fits.length
      ? `Several of this project's repositories have an open pull request; nothing was merged. Pass repository to merge one at a time, the one the others depend on first:\n${lines}`
      : `None of this project's repositories has an open pull request:\n${lines}`)
  }
  return {
    async status(conversationId, { logs = false, repository } = {}) {
      const place = await deps.place(conversationId)
      const one = meant(place, repository)
      if (one && place.repositories.length === 1) return toolText(await report(one, logs))
      if (one) {
        const others = place.repositories.filter((other) => other !== one).map((other) => other.name)
        return toolText({ repository: one.name, ...await report(one, logs), otherRepositories: others })
      }
      const reports = await Promise.all(place.repositories.map(async (each) => ({ repository: each.name, ...await report(each, logs) })))
      return toolText({ projectFolder: place.folder, repositories: reports })
    },
    async open(conversationId, { repository, ...draft }) {
      const place = await deps.place(conversationId)
      const one = meant(place, repository) ?? await onlyOne(place, "work")
      const result = await openPullRequest(deps.git, one.root, draft, one.startedFrom, deps.person)
      deps.changed()
      const left = result.uncommitted
        ? ` ${plural(result.uncommitted, "file")} with uncommitted changes stayed behind; commit what belongs in it and call again to push.`
        : ""
      return `${place.repositories.length > 1 ? `${one.name}: ` : ""}${openedSentence(result)}.${left}`
    },
    async merge(conversationId, { method, repository, as } = {}) {
      const place = await deps.place(conversationId)
      const one = meant(place, repository) ?? await onlyOne(place, "pull")
      const { pull, method: used, author } = await mergePullRequest(one.root, method, deps.person, as === "app")
      deps.changed()
      return `${place.repositories.length > 1 ? `${one.name}: ` : ""}${pull.state === "merged" ? "Merged" : "Asked GitHub to merge"} #${pull.number} into ${pull.base} (${used}${author ? `, ${authorWords(author)}` : ""}). The branch is kept.`
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

const REPOSITORY = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe("In a project folder holding several repositories, the one to act on: its folder there, as worktree_status lists it (such as `api`). Leave it out in a single repository.")

const AS_APP = z
  .literal("app")
  .optional()
  .describe(`Only after a refusal of the person's own GitHub token, and only when the person has chosen it: go as ${MAKO_GITHUB_APP} this once. Never on your own.`)

/** How every pull request tool picks its repository, said once in each description. */
const ONE_PER_REPOSITORY =
  "A project folder holding several repositories has one pull request per repository, each on the Thread's branch: pass repository to pick one. Without it, the tool acts on the repository this Session's folder is inside, or on the only one there is;"

/**
 * The pull request tools on a conversation's `mako` server, for the branch
 * the calling conversation edits on, one repository at a time. GitHub is
 * reached through the user's own `gh` login, as the Git sidebar reaches it.
 */
export function registerPullRequestTools(server: McpServer, tools: PullRequestTools, conversationId: () => string): void {
  server.registerTool(
    "pull_request_status",
    {
      description:
        `Call before opening, updating or merging this branch's pull request, and when the user asks about its checks or reviews. Reads the pull request of the branch this Session edits on: each check with its state and link, reviews, unresolved review comments by file and line, whether GitHub would merge it, and with logs: true the end of each failed GitHub Actions job's output. With none open, says what opening one would do: the base it targets, the commits it carries, the repository's pull request template, and what's in the way. ${ONE_PER_REPOSITORY} in the project folder itself it reports every repository, each under its name. Changes nothing.`,
      inputSchema: z.object({
        logs: z.boolean().optional().describe("Include the end of each failed GitHub Actions job's log."),
        repository: REPOSITORY,
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ logs, repository }) => reply(() => tools.status(conversationId(), { logs, repository }))
  )
  server.registerTool(
    "pull_request_open",
    {
      description:
        `Call when the user asks to open a pull request, or to push to or update the open one. Pushes the branch this Session edits on, never forcing, and opens its pull request; when one is open already it pushes the new commits instead, and edits its title or body only when you pass them. Commit what belongs in it first: uncommitted files stay behind, and the reply says how many. The base defaults to the branch this Thread's worktree started from when origin has it, else the repository's default. Refused on the default branch, with no commits to carry, or when origin has commits the branch lacks. ${ONE_PER_REPOSITORY} in the project folder itself it acts on the only repository with work, and when several have work it lists where each stands and pushes nothing, so call it once per repository, each with a title and body for that repository's own change. When one repository's change needs another's, say so in both bodies, with a link to the other pull request. In a cloud Thread whose person opens pull requests as themselves, it pushes and opens with their own GitHub token; when theirs can't be used it refuses with what happened and pushes nothing, so tell the person and let them choose. Use this instead of \`gh pr create\`, so the base and the push follow the same rules as the Git sidebar and the user sees it there at once.\n\nWrite the title and body from what the branch does and why, by these rules:\n\n${PULL_REQUEST_WRITING}`,
      inputSchema: z.object({
        title: z.string().max(256).optional().describe("Required for a new pull request; for an open one, only to change it."),
        body: z.string().max(60_000).optional().describe("Markdown; for an open one, only to change it."),
        base: z.string().max(256).optional().describe("The branch to merge into, when not the default."),
        draft: z.boolean().optional().describe("Open it as a draft. Applies only when opening."),
        repository: REPOSITORY,
        as: AS_APP,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (draft) => reply(() => tools.open(conversationId(), draft))
  )
  server.registerTool(
    "pull_request_merge",
    {
      description:
        `Call only when the user asks to merge this branch's pull request on GitHub. Merges it with the method given, or the first the repository allows of squash, merge and rebase. Refused while it conflicts, a check fails or is still running, or changes are requested; the reply says which. The branch is kept, since this Thread's worktree may still be on it. ${ONE_PER_REPOSITORY} in the project folder itself it merges the only open one, and when several are open it lists them and merges none. Merge a project's pull requests one at a time, the one the others depend on first, and use method merge for a repository whose commits another one pins by hash: a squash or rebase puts different commits on its default branch, and the pinned one is left off it.`,
      inputSchema: z.object({ method: z.enum(MERGE_METHODS).optional(), repository: REPOSITORY, as: AS_APP }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ method, repository, as }) => reply(() => tools.merge(conversationId(), { method, repository, as }))
  )
}
