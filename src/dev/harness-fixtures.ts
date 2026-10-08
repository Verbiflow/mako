import type { HarnessDescriptor, HarnessUsage, LiveCapabilities } from "@/lib/types"
import { harnessDescriptors } from "./harness-descriptors"

/** Every harness the host installs, live and resumable as on a Mac with each signed in. */
export const fixtureHarnesses: HarnessDescriptor[] = harnessDescriptors.map((entry) => ({ ...entry, live: true }))

function installed(provider: string) {
  const entry = harnessDescriptors.find((candidate) => candidate.provider === provider)
  if (!entry) throw new Error(`No installed harness ${provider}`)
  return entry
}

/** What a harness declares, for a fixture descriptor built by hand. */
export function fixtureCapabilities(provider: string): LiveCapabilities {
  return installed(provider).capabilities
}

/** What a harness declares it reports about usage, for a fixture descriptor built by hand. */
export function fixtureUsage(provider: string): HarnessUsage {
  return installed(provider).usage
}
