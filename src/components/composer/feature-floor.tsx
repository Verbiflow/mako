import { useState } from "react"
import type { HarnessFeatureKey } from "@mako/host/contracts/harness-features"
import { HARNESS_FEATURES } from "@mako/host/contracts/harness-features"
import { Shimmer } from "@/components/ui/shimmer"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { featureFloor, featureFloorText } from "@/lib/runtime-versions"
import { providers, useProviders } from "@/state/providers"

/**
 * In place of a shared feature's control, when the installed CLI predates
 * the release that added the harness's own form of it: the version it
 * needs, the one installed, and the update. The rest of the harness runs as
 * it is.
 */
export function FeatureFloorLine({ harness, feature }: { harness: string; feature: HarnessFeatureKey }) {
  useHarnessIdentity()
  const updates = useProviders((state) => state.runtimeUpdates)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const floor = featureFloor(updates, harness, feature)
  if (!floor) return null
  const label = harnessLabel(harness)
  const update = async () => {
    setPending(true)
    setFailure(undefined)
    try {
      const next = await providers.runRuntimeUpdate(floor.id)
      if (next.result?.outcome === "failed") setFailure(next.result.message ?? "The updater did not finish.")
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  const text = pending
    ? `Updating ${label}…`
    : failure
      ? `${label} wasn't updated: ${failure}`
      : `${featureFloorText(label, HARNESS_FEATURES[feature].name, floor)}${floor.update ? "" : ` ${floor.owner}`}`
  return (
    <div role="status" data-feature-floor={feature} className="flex items-center gap-2 px-3 pb-2.5 text-ui text-muted-foreground">
      <span className="min-w-0 flex-1">{pending ? <Shimmer text={text} /> : text}</span>
      {floor.update ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void update()}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover disabled:opacity-60"
        >
          {failure ? "Try again" : "Update"}
        </button>
      ) : null}
    </div>
  )
}
