import { hostLog } from "../base/host-log.js"
import { nativeSpawnsOff, type NativeRoutingReading, type RoutedThread } from "../contracts/native-routing.js"
import type { HarnessVersions } from "../contracts/harness-versions.js"
import type { ProviderLiveDriver } from "./live-driver.js"
import type { LaunchReadings } from "./runtime-floor.js"

/**
 * Whether a launch switches the harness's own spawning off, read as it
 * launches: a Thread that becomes a lead mid-session gets the switch from its
 * next launch. Each switch is logged with the Thread's role.
 */
export function launchSpawnsOff(harness: string, via: string, conversation: string, routing: (() => RoutedThread) | undefined): boolean {
  const thread = routing?.()
  if (!thread || !nativeSpawnsOff(thread)) return false
  hostLog("routing", "native spawns off", { harness, via, role: thread.role, conversation })
  return true
}

/** What Diagnostics' reading takes of the host: each driver's control, and the version a new session of each harness launches. */
export interface NativeRoutingSources {
  liveDrivers: { list(): readonly Pick<ProviderLiveDriver, "provider" | "nativeRouting">[] }
  updateSources: { get(harness: string): { versions?: Pick<HarnessVersions, "tested" | "bundled"> } | undefined }
  launchReadings: Pick<LaunchReadings, "read">
}

/**
 * Each harness's routing state for Diagnostics: its control holds where the
 * version it was seen working on is the one a new session launches (for a
 * build Mako ships, the one it ships), and is unverified anywhere else.
 */
export function nativeRoutingReadings(host: NativeRoutingSources): Promise<NativeRoutingReading[]> {
  return Promise.all(host.liveDrivers.list().map(async ({ provider: harness, nativeRouting: routing }): Promise<NativeRoutingReading> => {
    if (routing.kind === "words") return { harness, state: "words", via: routing.reason }
    const versions = host.updateSources.get(harness)?.versions
    const installed = versions?.bundled ? versions.tested : await host.launchReadings.read(harness)
    return { harness, state: installed === routing.verified.version ? "control" : "unverified", via: routing.via, verified: routing.verified, ...installed && { installed } }
  }))
}
