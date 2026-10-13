import { belowOldestText, runtimeVersions } from "../contracts/harness-versions.js"
import type { ExecutionContext } from "../contracts/execution-context.js"
import { parseVersion } from "../contracts/runtime-version.js"
import type { RuntimeUpdateSource } from "./update-source.js"

export interface RuntimeFloor {
  /** Why a launched runtime is too old to keep, or nothing. */
  refusal(provider: string, context: ExecutionContext | undefined): string | undefined
  /** The harness's declared oldest version, which a reopened session's version change is judged by. */
  oldest(provider: string): string | undefined
}

/**
 * The launch's backstop for a harness below its declared oldest version.
 * The composer has already said so above its input when the harness was
 * picked; this keeps a send that went ahead from running on a client Mako
 * doesn't speak. A runtime that reported no version, or one the declaration
 * can't place, is never refused.
 */
export function runtimeFloor(
  source: (provider: string) => RuntimeUpdateSource | undefined,
  label: (provider: string) => string
): RuntimeFloor {
  return {
    refusal(provider, context) {
      const declared = source(provider)
      const runtime = context?.runtime
      if (!declared?.versions || runtime?.kind !== "reported") return undefined
      const version = parseVersion(runtime.version)
      if (!version) return undefined
      const standing = runtimeVersions(version, declared.versions, declared.belowOldest)
      return standing?.standing === "below-oldest"
        ? `${belowOldestText(label(provider), version, declared.versions.oldest)} Update it in Settings › Agents, then send again.`
        : undefined
    },
    oldest: (provider) => {
      const versions = source(provider)?.versions
      return versions?.bundled ? undefined : versions?.oldest
    },
  }
}
