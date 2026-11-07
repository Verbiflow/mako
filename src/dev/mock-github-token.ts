import type { CommitAuthor, GitHubAuthorship } from "@mako/host/contracts/github-authorship"
import type { GitHubTokenListing } from "@mako/host/contracts/github-person"

/**
 * "Open pull requests as me" and who cloud commits are authored as, for `?mock`: off until a token is saved, and As
 * you. `github-token=on` starts with Ada's, `=expired` with one that lapsed; `github-authorship=mako` starts As Mako,
 * `=missing` is a cloud without the setting, `=failed` can't be read, `=refused` can't be saved, and `=unanswered` saves
 * but loses its answer.
 * Saving checks the shape a GitHub token has and answers after a moment, as the cloud does; one ending `refused` is
 * refused with GitHub's words, so the form's error can be seen.
 */
export function mockGitHubToken() {
  const params = new URLSearchParams(globalThis.location?.search)
  const scene = params.get("github-token")
  const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
  let kept: GitHubTokenListing | null =
    scene === "on" ? { login: "ada", savedAt: daysFromNow(-3), expiresAt: daysFromNow(57) } : scene === "expired" ? { login: "ada", savedAt: daysFromNow(-95), expiresAt: daysFromNow(-5) } : null
  let as: CommitAuthor = params.get("github-authorship") === "mako" ? "mako" : "you"
  const authorship = (): GitHubAuthorship => ({ as, pullRequests: as === "mako" ? "mako" : kept ? "you" : "mako-fallback", login: kept?.login ?? null })
  const pause = () => new Promise((resolve) => setTimeout(resolve, 700))
  return {
    githubToken: async () => kept,
    githubTokenSave: async (token: string, repository?: string) => {
      await pause()
      if (token.endsWith("refused")) throw new Error(`This token can't reach ${repository ?? "acme/shop"}. Give it access to that repository on GitHub.`)
      kept = { login: "ada", savedAt: new Date().toISOString(), expiresAt: daysFromNow(90) }
      return kept
    },
    githubTokenRemove: async () => {
      await pause()
      kept = null
    },
    githubAuthorship: async () => {
      if (params.get("github-authorship") === "failed") throw new Error("Error invoking remote method 'mako:github-authorship': GET answered 500")
      return params.get("github-authorship") === "missing" ? null : authorship()
    },
    githubAuthorshipSave: async (next: CommitAuthor) => {
      await pause()
      if (params.get("github-authorship") === "unanswered") as = next
      if (params.get("github-authorship") === "refused" || params.get("github-authorship") === "unanswered") throw new Error("Error invoking remote method 'mako:github-authorship-save': PUT answered 500")
      as = next
      return authorship()
    },
  }
}
