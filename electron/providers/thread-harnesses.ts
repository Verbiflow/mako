import type { ThreadHarnesses } from "../thread-harnesses.js"
import { harnessLabel } from "./harness-descriptors.js"
import type { ProviderHost } from "./host.js"

export function threadHarnesses(host: ProviderHost): ThreadHarnesses {
  return {
    label: (harness) => harnessLabel(host, harness),
    processProbes: () => host.processProbes.list(),
    sessionEmitter: (harness) => host.sessionEmitters.get(harness),
  }
}
