import { threadsStore } from "@/state/thread-store"
import { useThreads } from "@/state/thread-store"
import { useProviders } from "@/state/providers"
import { providerStore } from "@/state/providers"
import type { Harness } from "@/lib/types"

export function harnessLabel(harness: Harness): string {
  return (
    threadsStore.get().descriptors.find((entry) => entry.provider === harness)
      ?.displayName ??
    providerStore.get().profiles[harness]?.label ??
    harness
  )
}

/** Current registered display names, including unavailable harnesses. */
export function harnessLabels(): Record<string, string> {
  const labels = Object.fromEntries(
    Object.values(providerStore.get().profiles).map((entry) => [
      entry.id,
      entry.label,
    ])
  )
  for (const entry of threadsStore.get().descriptors)
    labels[entry.provider] = entry.displayName
  return labels
}

/** Subscribe only to identity metadata, never streaming messages. */
export function useHarnessIdentity(): void {
  useThreads((state) => state.descriptors)
  useProviders((state) => state.profiles)
}

export function useHarnessLabels(): Record<string, string> {
  useHarnessIdentity()
  return harnessLabels()
}
