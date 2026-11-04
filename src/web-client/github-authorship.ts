import { GitHubAuthorshipSchema } from "@mako/host/contracts/github-authorship"
import type { GitHubAuthorships } from "@/state/github-authorship"
import type { Gateway } from "./gateway"

/** Who cloud commits and pull requests are authored as, from a browser: the account's, through the gateway, as a Mac's host reaches it. */
export function webGitHubAuthorships(gateway: Gateway, accountId: string): GitHubAuthorships {
  const path = `/v1/accounts/${encodeURIComponent(accountId)}/github-authorship`
  return {
    read: async () => GitHubAuthorshipSchema.parse(await gateway.rest("GET", path)),
    save: async (as) => GitHubAuthorshipSchema.parse(await gateway.rest("PUT", path, { as })),
  }
}
