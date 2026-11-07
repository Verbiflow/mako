import { z } from "zod"
import type { HarnessUpdateCommand } from "@mako/host/contracts/harness-updates"

/**
 * Whether a harness's pinned tested build is still published, asked where its own install plans fetch it: a
 * versioned installer's URL (Devin's `static.devin.ai/cli/<version>/setup.sh`) still answers, or npm still lists
 * `<package>@<version>`. A vendor can withdraw a build after Mako pins it (Devin withdrew 3000.12.17 the day it was
 * tested), and then every install of it fails; the daily harness bump asks this so a withdrawn build opens a bump
 * before anyone's install does. Only plans that name the version are asked: an installer that takes it as an argument
 * (Grok's `bash -s <version>`) answers for every version.
 */

/** What says where a plan fetches the build from. */
export type BuildSource = { kind: "url"; url: string } | { kind: "npm"; name: string }

const WITHDRAWN = new Set([403, 404, 410])
const FETCH_TIMEOUT_MS = 10_000
const NpmVersions = z.object({ versions: z.record(z.string(), z.json()) })

/** The places `plans` fetch `version` from. */
export function buildSources(plans: readonly HarnessUpdateCommand[], version: string): BuildSource[] {
  return plans.flatMap((plan): BuildSource[] => {
    const pinned = plan.args.flatMap((arg) => {
      const match = /^(@?[^@\s]+)@([^@\s]+)$/.exec(arg)
      return match?.[2] === version ? [match[1]!] : []
    })
    if (plan.command === "npm" && pinned.length) return pinned.map((name) => ({ kind: "npm", name }))
    const url = plan.args.map((arg) => /\bcurl\b[^|]*?\b(https:\/\/\S+)/.exec(arg)?.[1]).find((found) => found !== undefined)
    return url?.includes(version) ? [{ kind: "url", url }] : []
  })
}

/**
 * Why `version` is no longer published at one of `plans`' sources, in words for a bump's body, or undefined while
 * every source still has it, or none could say (a network failure says nothing of the build).
 */
export async function unpublished(plans: readonly HarnessUpdateCommand[], version: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  for (const source of buildSources(plans, version)) {
    try {
      if (source.kind === "url") {
        const response = await fetcher(source.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        await response.body?.cancel()
        if (WITHDRAWN.has(response.status)) return `${source.url} answers ${response.status}`
        continue
      }
      const url = `https://registry.npmjs.org/${source.name.replaceAll("/", "%2F")}`
      const response = await fetcher(url, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (WITHDRAWN.has(response.status)) return `${url} answers ${response.status}`
      if (!response.ok) continue
      const listed = NpmVersions.safeParse(await response.json())
      if (listed.success && !Object.hasOwn(listed.data.versions, version)) return `npm lists no ${source.name}@${version}`
    } catch {
      // Unreachable now is not withdrawn: the next day's check asks again.
    }
  }
  return undefined
}
