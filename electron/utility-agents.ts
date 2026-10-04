import { agentOrder } from "./contracts/agent-order.js"
import { harnessProfiles } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import { harnessesByUse } from "./threads.js"
import type { UtilityAgent } from "./utility-work.js"

/**
 * The signed-in agent apps that can do small work, in the order every task
 * picks an agent in: by when this Mac last used each, then by each harness's
 * declared priority. The window's composer pick isn't known here, so it
 * plays no part; the most recent conversation usually names it anyway.
 */
export async function utilityAgents(): Promise<UtilityAgent[]> {
  const profiles = await harnessProfiles()
  const signedIn = profiles.filter((profile) => profile.available && providerHost.utilityRunners.get(profile.id))
  const priority = Object.fromEntries(providerHost.harnesses.list().map((record) => [record.provider, record.presentation.firstRunPriority]))
  return agentOrder({ signedIn: signedIn.map((profile) => profile.id), priority, recent: harnessesByUse() }).flatMap((harness) => {
    const profile = signedIn.find((entry) => entry.id === harness)
    const runner = providerHost.utilityRunners.get(harness)
    return profile && runner ? [{ harness, label: profile.label, models: profile.models, runner }] : []
  })
}
