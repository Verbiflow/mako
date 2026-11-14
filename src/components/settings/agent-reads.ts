import { finTuningLine, finTuningWords, type FinTarget } from "@mako/host/contracts/fin-tuning"
import { harnessLabel } from "@/lib/harness-label"
import type { HarnessProfile } from "@/lib/types"

/** A target as the Apex reads it: the harness, then its model's words or how the person uses it there. */
export function targetLine(target: FinTarget, profiles: Readonly<Record<string, HarnessProfile>>): string {
  const words = target.settings && finTuningWords(profiles[target.harness]?.models ?? [], target.settings)
  const label = harnessLabel(target.harness)
  return words ? `${label} · ${finTuningLine(words)}` : target.settings?.model ? `${label} · ${target.settings.model}` : `${label}, on the model the person uses there`
}
