import type { HarnessDescriptor, LiveCapabilities } from "@/lib/types"
import { harnessDescriptors } from "./harness-descriptors"

/** Every harness the host installs, live and resumable as on a Mac with each signed in. */
export const fixtureHarnesses: HarnessDescriptor[] = harnessDescriptors.map((entry) => ({ ...entry, live: true }))

function installed(provider: string) {
  const entry = harnessDescriptors.find((candidate) => candidate.provider === provider)
  if (!entry) throw new Error(`No installed harness ${provider}`)
  return entry
}

/** What a harness declares, for a fixture descriptor built by hand. */
export function fixtureDeclarations(provider: string): Pick<HarnessDescriptor, "capabilities" | "usage" | "artifacts" | "unique"> {
  const { capabilities, usage, artifacts, unique } = installed(provider)
  return { capabilities, usage, artifacts, unique }
}

export function fixtureCapabilities(provider: string): LiveCapabilities {
  return installed(provider).capabilities
}
