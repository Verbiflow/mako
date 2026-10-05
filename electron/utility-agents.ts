import { harnessProfiles } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import type { UtilityAgent } from "./utility-work.js"

/** The signed-in harnesses that can do small work; `UtilityWork` puts them in the person's order. */
export async function utilityAgents(): Promise<UtilityAgent[]> {
  const profiles = await harnessProfiles()
  return profiles.flatMap((profile) => {
    const runner = providerHost.utilityRunners.get(profile.id)
    const defaults = providerHost.profiles.get(profile.id)?.defaults
    return profile.available && runner ? [{ harness: profile.id, label: profile.label, models: profile.models, defaultModel: profile.defaultModel, defaults, runner }] : []
  })
}

/** Every harness Mako can do small work through. */
export function utilityRunners(): string[] {
  return providerHost.utilityRunners.list().map((runner) => runner.provider)
}
