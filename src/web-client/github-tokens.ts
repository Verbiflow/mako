import { GitHubTokenAnswerSchema, GitHubTokenListingSchema } from "@mako/host/contracts/github-person"
import type { GitHubTokens } from "@/state/github-token"
import type { Gateway } from "./gateway"

/** "Open pull requests as me" from a browser: the account's own GitHub token through the gateway, as a Mac's host reaches it. */
export function webGitHubTokens(gateway: Gateway, accountId: string): GitHubTokens {
  const path = `/v1/accounts/${encodeURIComponent(accountId)}/github-token`
  return {
    read: async () => GitHubTokenAnswerSchema.parse(await gateway.rest("GET", path)).token,
    save: async (token, repository) => GitHubTokenListingSchema.parse(await gateway.rest("PUT", path, { token, ...repository && { repository } })),
    remove: async () => void (await gateway.rest("DELETE", path)),
    openUrl: (url) => void window.open(url, "_blank", "noopener"),
  }
}
