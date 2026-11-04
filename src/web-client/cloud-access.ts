import { CloudAccessGrantSchema, CloudAccessGrantsAnswerSchema, CloudAccessRepositorySchema, CloudAccessUsesAnswerSchema, type CloudAccessService } from "@mako/host/contracts/cloud-access"
import type { CloudAccessTransport } from "@/state/cloud-access"
import type { WebProject } from "./account"
import { accountListStore } from "./account-list"
import type { Gateway } from "./gateway"

/** A project's cloud access from a browser: the account's grants through the gateway, as a Mac's host reaches them. */
export function webCloudAccess(gateway: Pick<Gateway, "rest">, accountId: string): CloudAccessTransport {
  const path = (rest: string, repository: string) => `/v1/accounts/${encodeURIComponent(accountId)}/cloud-access${rest}?repository=${encodeURIComponent(repository)}`
  const service = (name: CloudAccessService) => `/${encodeURIComponent(name)}`
  return {
    grants: async (repository) => CloudAccessGrantsAnswerSchema.parse(await gateway.rest("GET", path("", repository))).grants,
    save: async (repository, name, token, account) => CloudAccessGrantSchema.parse(await gateway.rest("PUT", path(service(name), repository), { token, ...account && { account } })),
    remove: async (repository, name) => void (await gateway.rest("DELETE", path(service(name), repository))),
    uses: async (repository) => CloudAccessUsesAnswerSchema.parse(await gateway.rest("GET", path("/uses", repository))).uses,
    openUrl: (url) => void window.open(url, "_blank", "noopener"),
    threadTitle: (threadId) => accountListStore.get().rows.find((row) => row.runsOn.kind === "cloud" && row.runsOn.threadId === threadId)?.title,
  }
}

/**
 * The account's projects a cloud Thread can work in, newest first, each once: the repositories it named for the cloud
 * (`GET /v1/projects`, by when each was last used), and those of the Sessions this browser lists, by when the person
 * last prompted there. A cloud machine's Sessions are listed without a repository, so an account whose projects are
 * cloud-only has only the first.
 */
export function listedRepositories(rows: ReadonlyArray<{ repository?: { url: string }; promptedAt?: string; createdAt?: string }>, projects: ReadonlyArray<Pick<WebProject, "url" | "usedAt">> = []): string[] {
  const latest = new Map<string, number>()
  const seen = (url: string, at: string | undefined) => {
    if (!CloudAccessRepositorySchema.safeParse(url).success) return
    latest.set(url, Math.max(latest.get(url) ?? 0, Date.parse(at ?? "") || 0))
  }
  for (const project of projects) seen(project.url, project.usedAt)
  for (const row of rows) if (row.repository) seen(row.repository.url, row.promptedAt ?? row.createdAt)
  return [...latest].sort((left, right) => right[1] - left[1]).map(([url]) => url)
}
