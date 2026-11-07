import { GitHubAuthorshipSchema } from "@mako/host/contracts/github-authorship"
import type { GitHubAuthorships } from "@/state/github-authorship"
import { GatewayError, type Gateway } from "./gateway"

/**
 * Who cloud commits and pull requests are authored as, from a browser: the account's, through the gateway, as a Mac's
 * host reaches it; null from a gateway that doesn't keep it yet.
 */
export function webGitHubAuthorships(gateway: Pick<Gateway, "rest">, accountId: string): GitHubAuthorships {
  const path = `/v1/accounts/${encodeURIComponent(accountId)}/github-authorship`
  return {
    read: async () => {
      try {
        return GitHubAuthorshipSchema.parse(await gateway.rest("GET", path))
      } catch (error) {
        if (error instanceof GatewayError && error.status === 404) return null
        throw error
      }
    },
    save: async (as) => GitHubAuthorshipSchema.parse(await gateway.rest("PUT", path, { as })),
  }
}
