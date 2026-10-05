import type { HarnessDescriptor } from "../contracts/providers-acp.js"
import type { ProviderHost } from "./host.js"
import { recoveryCapabilities } from "./live-driver.js"

/** An installed harness and the name Mako shows for it. */
export interface NamedHarness {
  id: string
  label: string
}

/** Every installed harness with its name, in Mako's order. */
export function namedHarnesses(host: ProviderHost): NamedHarness[] {
  return host.harnesses.list().map(({ provider }) => ({ id: provider, label: harnessLabel(host, provider) }))
}

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

/** What the renderer is told about each installed harness, in Mako's order. */
export function describeHarnesses(host: ProviderHost, here: HarnessAvailability): HarnessDescriptor[] {
  return host.harnesses.list().map(({ provider, presentation }) => {
    const candidate = host.liveDrivers.get(provider)
    const driver = candidate && here.live(provider) ? candidate : undefined
    const descriptor: HarnessDescriptor = {
      provider,
      displayName: harnessLabel(host, provider),
      presentation,
      defaults: host.profiles.get(provider)?.defaults,
      resumable: here.resumable.has(provider),
      live: driver !== undefined,
      canResume: driver?.canResume ?? false,
      observesNativeAgents: driver?.observesNativeAgents === true,
      canSteer: Boolean(driver?.steer),
      recovery: recoveryCapabilities(driver),
    }
    if (driver?.steering) descriptor.steering = driver.steering
    if (driver?.modes?.length) descriptor.modes = [...driver.modes]
    if (driver?.defaultMode) descriptor.defaultMode = driver.defaultMode
    return descriptor
  })
}
