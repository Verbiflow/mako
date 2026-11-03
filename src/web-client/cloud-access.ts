import { CloudAccessGrantSchema, CloudAccessGrantsAnswerSchema, CloudAccessUsesAnswerSchema, type CloudAccessService } from "@mako/host/contracts/cloud-access"
import type { CloudAccessTransport } from "@/state/cloud-access"
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
 * The account's projects a cloud Thread can work in, from the list this browser follows: each Session's repository,
 * the one the person prompted in latest first.
 */
export function listedRepositories(rows: ReadonlyArray<{ repository?: { url: string }; promptedAt?: string; createdAt?: string }>): string[] {
  const latest = new Map<string, number>()
  for (const row of rows) {
    if (!row.repository) continue
    const at = Date.parse(row.promptedAt ?? row.createdAt ?? "") || 0
    latest.set(row.repository.url, Math.max(latest.get(row.repository.url) ?? 0, at))
  }
  return [...latest].sort((left, right) => right[1] - left[1]).map(([url]) => url)
}
