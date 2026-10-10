import type { HarnessDescriptor } from "../contracts/providers-acp.js"
import type { ProviderHost } from "./host.js"

/** The name Mako shows for a harness: its profile's label. */
export function harnessLabel(host: ProviderHost, provider: string): string {
  return host.profiles.get(provider)?.label ?? provider
}

/** What this Mac can do with the harnesses right now. */
export interface HarnessAvailability {
  /** Harnesses whose live driver can start here. */
  live: (provider: string) => boolean
  /** Harnesses whose sessions a headless run can continue here. */
  resumable: ReadonlySet<string>
}

/**
 * What the renderer is told about each installed harness, in Mako's order.
 * Capabilities are the harness's declarations whether or not it runs here;
 * `live` says whether it does.
 */
export function describeHarnesses(host: ProviderHost, here: HarnessAvailability): HarnessDescriptor[] {
  return host.harnesses.list().map(({ provider, presentation, capabilities, usage, artifacts, unique }) => {
    const driver = host.liveDrivers.get(provider)
    const descriptor: HarnessDescriptor = {
      provider,
      displayName: harnessLabel(host, provider),
      presentation,
      defaults: host.profiles.get(provider)?.defaults,
      resumable: here.resumable.has(provider),
      live: driver !== undefined && here.live(provider),
      capabilities,
      usage,
      artifacts,
      unique,
    }
    if (driver?.modes?.length) descriptor.modes = [...driver.modes]
    if (driver?.defaultMode) descriptor.defaultMode = driver.defaultMode
    return descriptor
  })
}
