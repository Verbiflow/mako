import { z } from "zod"

/**
 * "Open pull requests as me". A cloud Thread reaches GitHub with Mako's GitHub App, so what it pushes and the pull
 * requests it opens are the App's on GitHub. With this on, they carry the person's own GitHub token, and GitHub names
 * the person: pushes and what writes a pull request (open, edit, merge). Reads (the clone, fetches, checks, reviews)
 * stay with the App, whose access is the one rule for what a cloud Thread may read.
 *
 * Off by default. On is the account keeping the token: the cloud checks it with GitHub, keeps it encrypted beside the
 * account's other sign-ins, and gives it to the account's cloud machines as they ask for those. No device keeps it,
 * and none is shown it again, only who it belongs to and when it lapses. Turning it off removes it from the account,
 * and each running machine removes its copy before its next pull request.
 *
 * Its failures never go quietly to the App instead: a pull request that can't be opened as the person is refused with
 * what happened, a way to fix it (a new token) and the person's choice to open it as the App this once.
 */

/** Mako's GitHub App as GitHub names it on what it opens. */
export const MAKO_GITHUB_APP = "Mako by Verbiflow"

/** Settings' place for it (Settings › Git), as `mako:settings` opens it. */
export const GITHUB_PERSON_SETTINGS = "git#pull-requests"

/** What the account keeps, as any device sees it: never the token. */
export const GitHubTokenListingSchema = z.object({
  /** Who it belongs to on GitHub. */
  login: z.string().min(1).max(100),
  savedAt: z.string(),
  /** When GitHub says it lapses; null for a token without an expiry. */
  expiresAt: z.string().nullable(),
})
export type GitHubTokenListing = z.infer<typeof GitHubTokenListingSchema>

/** The account's answer: the token's listing while it's on, null while it's off. */
export const GitHubTokenAnswerSchema = z.object({ token: GitHubTokenListingSchema.nullable() })

/** A personal access token as GitHub prints one: fine-grained (`github_pat_…`) or classic (`ghp_…`). */
export const PERSON_TOKEN = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,250}$/

/** What a fine-grained token needs, as GitHub's form names each, for the repositories it should push to. */
export const PERSON_TOKEN_PERMISSIONS = [
  { name: "Contents", access: "Read and write" },
  { name: "Pull requests", access: "Read and write" },
  { name: "Metadata", access: "Read-only" },
] as const

/** GitHub's form for a new fine-grained token, with its name, description and permissions filled in. */
export const NEW_PERSON_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?name=Mako%20pull%20requests&description=Lets%20Mako%27s%20cloud%20Threads%20push%20and%20open%20pull%20requests%20as%20you.&contents=write&pull_requests=write&metadata=read"

/**
 * On a cloud machine, whether its pull requests open as its person, as its agent says it (`github-person` in
 * `machine-agent.ts`): `on` with whose token, `off`, or why theirs can't be used.
 */
export const GitHubPersonSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("on"), login: z.string().min(1).max(100), expiresAt: z.string().nullable() }).strict(),
  z.object({ state: z.literal("off") }).strict(),
  z.object({ state: z.literal("unusable"), problem: z.string().min(1).max(300) }).strict(),
  z.object({ state: z.literal("unknown"), problem: z.string().min(1).max(300) }).strict(),
])
export type GitHubPerson = z.infer<typeof GitHubPersonSchema>

/** Who a pull request action goes as: the person (their login), or Mako's App, as the person chose for this one. */
export type PullRequestAuthor = { as: "person"; login: string } | { as: "app"; chosen: boolean }

/** Why a pull request couldn't go as its person. */
export type PersonTokenReason = "expired" | "refused" | "no-access" | "unusable" | "unknown"

export type PersonTokenProblem = {
  reason: PersonTokenReason
  /** Whose token, when the machine knows. */
  login?: string
  /** The repository, `owner/name`, when it was about one. */
  repository?: string
  /** When it lapsed, for an expired one. */
  expiredAt?: string
  /** What the cloud or GitHub said, for `unusable` and `unknown`. */
  said?: string
}

/** A problem in words: what happened, then what to do. */
export type PersonTokenWords = { title: string; detail: string }

/** The words of a problem, as the transcript's notice and the agent both read them. */
export function personTokenWords(problem: PersonTokenProblem): PersonTokenWords {
  const whose = problem.login ? `@${problem.login}'s GitHub token` : "your GitHub token"
  const where = problem.repository ?? "this repository"
  switch (problem.reason) {
    case "expired":
      return { title: `Not opened: ${whose} expired`, detail: `It lapsed${problem.expiredAt ? ` on ${dayOf(problem.expiredAt)}` : ""}. Make a new one on GitHub and save it in Settings › Git.` }
    case "refused":
      return { title: `Not opened: GitHub refused ${whose}`, detail: "It may have been revoked or deleted. Make a new one on GitHub and save it in Settings › Git." }
    case "no-access":
      return { title: `Not opened: ${whose} can't push to ${where}`, detail: `Give it access to ${where} with Contents and Pull requests set to Read and write, or save another in Settings › Git.` }
    case "unusable":
    case "unknown":
      return { title: "Not opened: your GitHub token couldn't be used here", detail: `${problem.said ?? "Mako Cloud didn't give this machine your token."} Save it again in Settings › Git, or try again in a minute.` }
  }
}

/** A day as the agent and the notice both say it, the same on every device: "Oct 25, 2026". */
function dayOf(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? iso : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

const TAG = /<mako_pull_request_author reason="(expired|refused|no-access|unusable|unknown)"((?: [a-z]+="[^"<>]*")*) \/>/
const ATTRIBUTE = / ([a-z]+)="([^"<>]*)"/g

const attribute = (value: string) => value.replace(/["<>]/g, "")

/**
 * The refusal a pull request tool answers with: the problem in words, what the agent should tell the person, and a tag
 * the transcript draws as a notice with both choices (`readPersonTokenProblem`). Nothing was pushed as the App.
 */
export function personTokenRefusal(problem: PersonTokenProblem): string {
  const { title, detail } = personTokenWords(problem)
  const attributes = [
    problem.login ? ` login="${attribute(problem.login)}"` : "",
    problem.repository ? ` repository="${attribute(problem.repository)}"` : "",
    problem.expiredAt ? ` expired="${attribute(problem.expiredAt)}"` : "",
    problem.said ? ` said="${attribute(problem.said)}"` : "",
  ].join("")
  return [
    `${title}. ${detail}`,
    `The person opens pull requests as themselves (Settings › Git, "Open pull requests as me"), so Mako didn't open it as ${MAKO_GITHUB_APP} instead. Tell them what happened and offer both: update the token in Settings › Git, or open it as ${MAKO_GITHUB_APP} this once. Call pull_request_open again with as: "app" only if they choose that.`,
    `<mako_pull_request_author reason="${problem.reason}"${attributes} />`,
  ].join("\n\n")
}

/** The problem a pull request tool's refusal carries, or undefined for any other text. Cheap on text without one. */
export function readPersonTokenProblem(text: string | undefined): PersonTokenProblem | undefined {
  if (!text || !text.includes("<mako_pull_request_author")) return undefined
  const found = TAG.exec(text)
  if (!found) return undefined
  // SAFETY: TAG's first group matches only the five reasons PersonTokenReason names.
  const problem: PersonTokenProblem = { reason: found[1] as PersonTokenReason }
  for (const [, name, value] of found[2]!.matchAll(ATTRIBUTE)) {
    if (name === "login") problem.login = value
    else if (name === "repository") problem.repository = value
    else if (name === "expired") problem.expiredAt = value
    else if (name === "said") problem.said = value
  }
  return problem
}

/** What the person sends to choose the App for the pull request their token couldn't open. */
export function openAsAppPrompt(repository?: string): string {
  return `Open it as ${MAKO_GITHUB_APP} instead${repository ? ` (${repository})` : ""}: call pull_request_open again with as: "app" and the same title, body and base.`
}

/** "as @ada" or "as Mako by Verbiflow", for the line that says a pull request opened. */
export function authorWords(author: PullRequestAuthor): string {
  return author.as === "person" ? `as @${author.login}` : `as ${MAKO_GITHUB_APP}`
}
