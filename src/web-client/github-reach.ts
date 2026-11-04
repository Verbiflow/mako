import {
  GitHubAskAnsweredSchema,
  GitHubAskConflictSchema,
  GitHubAsksAnswerSchema,
  GitHubReachAnswerSchema,
  GitHubReachSavedSchema,
  GitHubReachSchema,
} from "@mako/host/contracts/github-reach"
import type { GitHubReachTransport } from "@/state/github-reach"
import { accountListStore } from "./account-list"
import { GatewayError, type Gateway } from "./gateway"

/** A project's GitHub reach from a browser: the account's routes through the gateway, as a Mac's host reaches them. */
export function webGitHubReach(gateway: Pick<Gateway, "rest">, accountId: string): GitHubReachTransport {
  const account = `/v1/accounts/${encodeURIComponent(accountId)}`
  const reachPath = (repository: string) => `${account}/github-reach?repository=${encodeURIComponent(repository)}`
  return {
    read: async (repository) => GitHubReachAnswerSchema.parse(await gateway.rest("GET", reachPath(repository))),
    save: async (repository, reach) => GitHubReachSavedSchema.parse(await gateway.rest("PUT", reachPath(repository), GitHubReachSchema.parse(reach))).reach,
    asks: async () => GitHubAsksAnswerSchema.parse(await gateway.rest("GET", `${account}/github-asks`)).asks,
    answer: async (askId, answer) => {
      try {
        return { ask: GitHubAskAnsweredSchema.parse(await gateway.rest("POST", `${account}/github-asks/${encodeURIComponent(askId)}`, { answer })).ask, already: false }
      } catch (error) {
        const ask = error instanceof GatewayError && error.status === 409 ? GitHubAskConflictSchema.safeParse(error.problem).data?.detail : undefined
        if (!ask) throw error
        return { ask, already: true }
      }
    },
    threadTitle: (threadId) => accountListStore.get().rows.find((row) => row.runsOn.kind === "cloud" && row.runsOn.threadId === threadId)?.title,
  }
}
