import type { GitHubTokenListing } from "@mako/host/contracts/github-person"

/**
 * "Open pull requests as me" for `?mock`: off until a token is saved. `github-token=on` starts with Ada's, `=expired`
 * with one that lapsed. Saving checks the shape a GitHub token has and answers after a moment, as the cloud does;
 * one ending `refused` is refused with GitHub's words, so the form's error can be seen.
 */
export function mockGitHubToken() {
  const scene = new URLSearchParams(globalThis.location?.search).get("github-token")
  const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
  let kept: GitHubTokenListing | null =
    scene === "on" ? { login: "ada", savedAt: daysFromNow(-3), expiresAt: daysFromNow(57) } : scene === "expired" ? { login: "ada", savedAt: daysFromNow(-95), expiresAt: daysFromNow(-5) } : null
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
  }
}
