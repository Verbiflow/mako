import type { CloudAccessGrant, CloudAccessService, CloudAccessUse } from "@mako/host/contracts/cloud-access"

/** A fixture's scene for a project's cloud access, from its address's `cloud-access=`. */
export type CloudAccessScene = "none" | "connected" | "lapsed" | "refused"

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

/** A project's grants and their uses, as a fixture keeps them. */
export type CloudAccessFixture = { grants: CloudAccessGrant[]; uses: CloudAccessUse[] }

/** Each scene's grants and uses, made up: no real account, team or Thread. */
export function cloudAccessScene(scene: CloudAccessScene, repository: string): CloudAccessFixture {
  if (scene === "none" || scene === "refused") return { grants: [], uses: [] }
  const lapsed = scene === "lapsed"
  const cloudflare: CloudAccessGrant = {
    service: "cloudflare",
    repository,
    account: { id: "0f3c9a1e5b7d4c2a8e6f1b3d5a7c9e21", name: "Acme Shop" },
    variables: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    savedAt: minutesAgo(lapsed ? 60 * 24 * 95 : 60 * 24 * 6),
    expiresAt: lapsed ? daysFromNow(-4) : daysFromNow(84),
    lastGiven: { at: minutesAgo(lapsed ? 60 * 24 * 5 : 4), threadId: "t-cart-checkout" },
  }
  const uses: CloudAccessUse[] = [
    { service: "cloudflare", threadId: "t-cart-checkout", machine: "m-7f2c", at: minutesAgo(lapsed ? 60 * 24 * 5 : 4) },
    { service: "cloudflare", threadId: "t-worker-cache", machine: "m-91ab", at: minutesAgo(lapsed ? 60 * 24 * 6 : 52) },
    { service: "cloudflare", threadId: "t-cart-checkout", machine: "m-7f2c", at: minutesAgo(60 * 26) },
    { service: "cloudflare", threadId: "t-preview-deploys", machine: null, at: minutesAgo(60 * 24 * 3) },
  ]
  return { grants: [cloudflare], uses }
}

/** The fixtures' cloud Threads by name, as a device that listed them would know them. */
export const CLOUD_ACCESS_THREADS = {
  "t-cart-checkout": "Deploy the checkout worker",
  "t-worker-cache": "Cache product pages at the edge",
} satisfies Record<string, string>

/**
 * The transport's answers for a fixture, kept per project: saving answers after a moment, as the cloud does, and a
 * token ending `refused` (or every token, in the `refused` scene) is refused in the service's words, so the form's
 * error can be seen.
 */
export function mockCloudAccessStore(scene: CloudAccessScene) {
  const projects = new Map<string, CloudAccessFixture>()
  const project = (repository: string) => {
    let found = projects.get(repository)
    if (!found) projects.set(repository, (found = cloudAccessScene(scene, repository)))
    return found
  }
  const pause = () => new Promise((resolve) => setTimeout(resolve, 700))
  return {
    grants: async (repository: string) => project(repository).grants,
    save: async (repository: string, service: CloudAccessService, token: string, account?: string): Promise<CloudAccessGrant> => {
      await pause()
      if (scene === "refused" || token.endsWith("refused"))
        throw new Error(service === "cloudflare" ? "Cloudflare refused this token: it reaches 2 accounts. Name the one this project uses." : "Vercel refused this token: it has expired.")
      const grant: CloudAccessGrant = {
        service,
        repository,
        account: service === "cloudflare" ? { id: account || "0f3c9a1e5b7d4c2a8e6f1b3d5a7c9e21", name: account ? null : "Acme Shop" } : { id: account || "team_acme", name: account ? null : "Acme" },
        variables: service === "cloudflare" ? ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] : ["VERCEL_TOKEN", "VERCEL_ORG_ID"],
        savedAt: new Date().toISOString(),
        expiresAt: daysFromNow(90),
        lastGiven: null,
      }
      const kept = project(repository)
      kept.grants = [...kept.grants.filter((each) => each.service !== service), grant]
      return grant
    },
    remove: async (repository: string, service: CloudAccessService) => {
      await pause()
      const kept = project(repository)
      kept.grants = kept.grants.filter((each) => each.service !== service)
    },
    uses: async (repository: string) => {
      await pause()
      return project(repository).uses
    },
  }
}

/** The desk's `?mock` bridge methods: `cloud-access=none|connected|lapsed|refused`, `connected` by default. */
export function mockCloudAccess() {
  const asked = new URLSearchParams(globalThis.location?.search).get("cloud-access")
  const scene: CloudAccessScene = asked === "none" || asked === "lapsed" || asked === "refused" ? asked : "connected"
  const store = mockCloudAccessStore(scene)
  return {
    cloudAccess: store.grants,
    cloudAccessSave: store.save,
    cloudAccessRemove: store.remove,
    cloudAccessUses: store.uses,
  }
}
