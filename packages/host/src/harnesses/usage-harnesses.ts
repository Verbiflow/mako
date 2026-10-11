import type { UsageHarness } from "../usage/index.js"
import { harnessLabel } from "./harness-descriptors.js"
import type { ProviderHost } from "./host.js"

/** Every installed harness, as `usageSummary` counts it. */
export function usageHarnesses(host: ProviderHost): UsageHarness[] {
  return host.harnesses.list().map(({ provider }) => ({
    provider,
    label: harnessLabel(host, provider),
    history: host.usageHistories.get(provider),
  }))
}
