import { belowOldestText, runtimeVersions } from "../contracts/harness-versions.js"
import type { ExecutionContext } from "../contracts/execution-context.js"
import { parseVersion } from "../contracts/runtime-version.js"
import type { RuntimeUpdateSource } from "./update-source.js"

export interface RuntimeFloor {
  /** Why the runtime a launch would start is already known to be too old to start, or nothing. */
  before(provider: string): Promise<string | undefined>
  /** Why a launched runtime is too old to keep, or nothing. */
  refusal(provider: string, context: ExecutionContext | undefined): string | undefined
  /** The harness's declared oldest version, which a reopened session's version change is judged by. */
  oldest(provider: string): string | undefined
}

/**
 * The installed version a new session would launch, from the runtime
 * readings (`RuntimeUpdates.launchVersion`), which exist only once the
 * harnesses are open; until bound, nothing is known.
 */
export class LaunchReadings {
  private reader: ((provider: string) => Promise<string | undefined>) | undefined

  bind(reader: (provider: string) => Promise<string | undefined>): void {
    this.reader = reader
  }

  read(provider: string): Promise<string | undefined> {
    return this.reader?.(provider) ?? Promise.resolve(undefined)
  }
}

/**
 * A harness below its declared oldest version is not run. The composer has
 * already said so above its input when the harness was picked, from the
 * same reading; a send that went ahead is refused before anything starts
 * while that reading stands, and once launched when the runtime reports a
 * version no reading had (the binary moved, or was never read). A runtime
 * that reported no version, or one the declaration can't place, is never
 * refused.
 */
export function runtimeFloor(
  source: (provider: string) => RuntimeUpdateSource | undefined,
  label: (provider: string) => string,
  readings: LaunchReadings
): RuntimeFloor {
  const refused = (provider: string, reported: string | undefined) => {
    const declared = source(provider)
    const version = reported === undefined ? undefined : parseVersion(reported)
    if (!declared?.versions || !version) return undefined
    const standing = runtimeVersions(version, declared.versions, declared.belowOldest)
    return standing?.standing === "below-oldest"
      ? `${belowOldestText(label(provider), version, declared.versions.oldest)} Update it in Settings › Agents, then send again.`
      : undefined
  }
  return {
    before: async (provider) => source(provider)?.versions ? refused(provider, await readings.read(provider)) : undefined,
    refusal(provider, context) {
      const runtime = context?.runtime
      return runtime?.kind === "reported" ? refused(provider, runtime.version) : undefined
    },
    oldest: (provider) => {
      const versions = source(provider)?.versions
      return versions?.bundled ? undefined : versions?.oldest
    },
  }
}
