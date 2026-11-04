import { z } from "zod"

/**
 * GitHub reach: which repositories a project's cloud Threads may read besides their own. A cloud Thread's GitHub token
 * covers only its project's repository, with the person's own role there. Its reach adds one more token, read-only, for
 * the other repositories the person allowed, all under the project's owner. Least privilege stays the default: nothing
 * more until the person widens it per project in Settings, or with one tap on an agent's ask.
 *
 * The account's routes, per project (`?repository=`, the project's `https://github.com/<owner>/<name>`):
 * `GET /v1/accounts/:account/github-reach` answers its reach and its pending asks, `PUT` the same path sets its reach.
 * `GET /v1/accounts/:account/github-asks` lists every project's pending asks, and `POST …/github-asks/:ask` answers one.
 * A refusal is a problem document whose title says why in plain words; an ask already answered or expired is a 409
 * with the ask in its `detail`.
 */

/** The most repositories a project's chosen set holds. */
export const GITHUB_REACH_LIMIT = 50
/** The most characters of an agent's reason for an ask. */
export const GITHUB_ASK_WHY_LIMIT = 300
/** How often Settings reads the asks again while it's open. */
export const GITHUB_ASKS_REREAD_MS = 30_000

export const GITHUB_REACH_TITLE = "GitHub repositories"
export const GITHUB_REACH_HINT = "Which repositories this project's cloud Threads can read besides their own. They push only to their own."

const NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** A repository a project reaches, `owner/name`. */
export const GitHubReachRepositorySchema = z.string().max(200).regex(NAME)

/** A project as the account knows it: its GitHub repository's URL. */
export const GitHubReachProjectSchema = z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)

/** What a project's cloud Threads may read besides their own repository. */
export const GitHubReachSchema = z.discriminatedUnion("mode", [
  /** Nothing more: the default. */
  z.object({ mode: z.literal("repository") }),
  /** These, each under the project's owner. */
  z.object({ mode: z.literal("chosen"), repositories: z.array(GitHubReachRepositorySchema).max(GITHUB_REACH_LIMIT) }),
  /** Every repository of the owner's installation the person can read. */
  z.object({ mode: z.literal("installation") }),
])
export type GitHubReach = z.infer<typeof GitHubReachSchema>
export type GitHubReachMode = GitHubReach["mode"]

export const GITHUB_ASK_STATES = ["pending", "allowed-thread", "allowed-project", "declined", "expired"] as const
export const GitHubAskStateSchema = z.enum(GITHUB_ASK_STATES)
export type GitHubAskState = z.infer<typeof GitHubAskStateSchema>

/** A running cloud Thread's ask to read more repositories, and where it stands. Pending asks expire after 24 hours. */
export const GitHubAskSchema = z.object({
  id: z.string().min(1).max(200),
  /** The project's URL. */
  repository: z.string(),
  threadId: z.string(),
  repositories: z.array(GitHubReachRepositorySchema).min(1).max(GITHUB_REACH_LIMIT),
  access: z.literal("read"),
  /** The agent's words. */
  why: z.string().max(GITHUB_ASK_WHY_LIMIT),
  askedAt: z.string(),
  state: GitHubAskStateSchema,
  answeredAt: z.string().nullable(),
})
export type GitHubAsk = z.infer<typeof GitHubAskSchema>

export const GITHUB_ASK_ANSWERS = ["thread", "project", "decline"] as const
export const GitHubAskAnswerSchema = z.enum(GITHUB_ASK_ANSWERS)
/** This Thread only while it lives, added to the project's chosen set, or no. */
export type GitHubAskAnswer = z.infer<typeof GitHubAskAnswerSchema>

/** `GET …/github-reach`: the project's reach and its pending asks, newest first. */
export const GitHubReachAnswerSchema = z.object({ reach: GitHubReachSchema, asks: z.array(GitHubAskSchema) })
export type GitHubReachView = z.infer<typeof GitHubReachAnswerSchema>
/** `PUT …/github-reach`. */
export const GitHubReachSavedSchema = z.object({ reach: GitHubReachSchema })
/** `GET …/github-asks`: every project's pending asks, newest first. */
export const GitHubAsksAnswerSchema = z.object({ asks: z.array(GitHubAskSchema) })
/** `POST …/github-asks/:ask`. */
export const GitHubAskAnsweredSchema = z.object({ ask: GitHubAskSchema })

/** An answer as it landed: `already` when the ask had been answered, or had expired, before this one reached it. */
export type GitHubAskOutcome = { ask: GitHubAsk; already: boolean }

/** An ask's JSON, as a problem's `detail` string carries it. */
const AskJsonSchema = z.string().transform((text, context) => {
  try {
    return GitHubAskSchema.parse(JSON.parse(text))
  } catch {
    context.addIssue({ code: "custom", message: "Not an ask's JSON" })
    return z.NEVER
  }
})

/** A 409's problem document: the ask as it stands in its `detail`, as an object or as its JSON in a string. */
export const GitHubAskConflictSchema = z.object({ detail: z.union([GitHubAskSchema, AskJsonSchema]) })

const PROJECT = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

/** A project URL's owner and name; undefined for anything that isn't one. */
export function projectRepository(url: string): { owner: string; name: string } | undefined {
  const match = url.length <= 300 ? PROJECT.exec(url) : null
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : undefined
}

/**
 * A repository the person typed for a project's chosen set, as `owner/name`: a name alone (under the project's owner),
 * `owner/name`, or its GitHub address. A refusal says why in Settings' words.
 */
export function typedReachRepository(text: string, project: string): { repository: string } | { refused: string } {
  const own = projectRepository(project)
  if (!own) return { refused: "This project has no GitHub repository." }
  const trimmed = text.trim().replace(/\.git$/, "").replace(/\/+$/, "")
  const bare = trimmed.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
  const full = bare.includes("/") ? bare : `${own.owner}/${bare}`
  const [, owner, name] = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(full) ?? []
  if (!owner || !name) return { refused: "Write it as owner/name." }
  if (owner.toLowerCase() !== own.owner.toLowerCase()) return { refused: `Only repositories under ${own.owner}.` }
  if (name.toLowerCase() === own.name.toLowerCase()) return { refused: "That's this project's own repository, which its Threads always reach." }
  return { repository: `${own.owner}/${name}` }
}
