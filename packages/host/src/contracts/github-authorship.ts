import { z } from "zod"

/**
 * Who a cloud Thread's commits and pull requests are authored as: the person who started it (`you`, the default) or
 * Mako's bot (`mako`), never anyone else. One setting for the account, in Settings › Git beside "Open pull requests as
 * me" (`github-person.ts`). Under `you` the machine's commits name the person; its pull requests go with their own
 * GitHub token when one is saved, and as Mako's App until then (`mako-fallback`), so GitHub credits the bot when one is
 * squashed. Under `mako` commits name Mako's bot with the person as co-author, and pull requests open as the App; a
 * saved token is kept but not used.
 */
export const COMMIT_AUTHORS = ["you", "mako"] as const
export type CommitAuthor = (typeof COMMIT_AUTHORS)[number]

/** Who a cloud Thread's pull requests actually go as: the person, Mako's App by choice, or the App until a token is saved. */
export const PULL_REQUESTS_AS = ["you", "mako", "mako-fallback"] as const
export type PullRequestsAs = (typeof PULL_REQUESTS_AS)[number]

/** The account's answer, read and saved alike (`/v1/accounts/:accountId/github-authorship`). */
export const GitHubAuthorshipSchema = z.object({
  as: z.enum(COMMIT_AUTHORS),
  pullRequests: z.enum(PULL_REQUESTS_AS),
  /** The saved token's login, else null. */
  login: z.string().min(1).max(100).nullable(),
})
export type GitHubAuthorship = z.infer<typeof GitHubAuthorshipSchema>

/**
 * What a cloud Thread's first pull request reply adds while its pull requests go as the App only because no token is
 * saved: the machine's `gh pr create` says the same, once per machine.
 */
export const PULL_REQUESTS_FALLBACK_SENTENCE =
  `Opened by Mako's bot: the person hasn't connected GitHub (Settings › Git, "Open pull requests as me"), so GitHub credits the bot when this is squashed.`
