import { resolveAccountLaunch } from "./accounts.js"
import { harnessProfiles } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import type { ProviderUtilityRunner, UtilityRunner } from "./providers/utility-runner.js"
import type { UtilityAgent } from "./utility-work.js"

/** The signed-in harnesses that can do small work; `UtilityWork` puts them in the person's order. */
export async function utilityAgents(): Promise<UtilityAgent[]> {
  const profiles = await harnessProfiles()
  return profiles.flatMap((profile) => {
    const runner = providerHost.utilityRunners.get(profile.id)
    const defaults = providerHost.profiles.get(profile.id)?.defaults
    return profile.available && runner ? [{ harness: profile.id, label: profile.label, models: profile.models, defaultModel: profile.defaultModel, defaults, runner: onSelectedAccount(runner) }] : []
  })
}

/** Each request resolves the selected account and holds it until the reply settles. */
function onSelectedAccount(runner: ProviderUtilityRunner): UtilityRunner {
  return {
    complete: async (request) => {
      const launch = await resolveAccountLaunch(runner.provider, process.env, { holder: { kind: "utility" } })
      try {
        return await runner.complete(request, launch.env)
      } finally {
        launch.hold?.release()
      }
    },
  }
}

/** Every harness Mako can do small work through. */
export function utilityRunners(): string[] {
  return providerHost.utilityRunners.list().map((runner) => runner.provider)
}
