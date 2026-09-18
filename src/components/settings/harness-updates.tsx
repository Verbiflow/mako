import { useState } from "react"
import { Action } from "@/components/ui/kit"
import { harnessLabel } from "@/lib/harness-label"
import { runtimeRowView } from "@/lib/runtime-updates"
import { providers, useProviders } from "@/state/providers"
import { cn } from "@/lib/utils"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { toast } from "sonner"
import type { HarnessUpdateInfo } from "../../../electron/contracts/harness-updates"

/** An installation's version and update action stay beside its provider's account. */
export function RuntimeRow({
  runtimeId,
  provider,
  info,
}: {
  runtimeId: string
  provider: string
  info: HarnessUpdateInfo
}) {
  const [pending, setPending] = useState(false)
  const updating = useProviders((state) =>
    Object.values(state.runtimeUpdates ?? {}).some(
      (runtime) => runtime.phase === "updating"
    )
  )
  const view = runtimeRowView(info)
  const runUpdate = async () => {
    const label = info.label ?? harnessLabel(provider)
    setPending(true)
    try {
      const next = await providers.runRuntimeUpdate(runtimeId)
      const result = next.result
      if (!result || result.outcome === "failed")
        toast.error(`${label} was not updated`, {
          description: result?.message ?? "The updater did not finish.",
          duration: ACTION_TOAST_MS,
          action: { label: "Try again", onClick: () => void runUpdate() },
        })
      else if (result.outcome === "updated")
        toast.success(`${label} is now ${result.to ?? "updated"}`, {
          description: "The installation was updated and its models refreshed.",
        })
      else
        toast(`${label} is already ${result.to ?? next.installed ?? "current"}`)
    } catch (error) {
      toast.error(`${label} was not updated`, {
        description: error instanceof Error ? error.message : String(error),
        duration: ACTION_TOAST_MS,
        action: { label: "Try again", onClick: () => void runUpdate() },
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      aria-label={info.label ?? `${harnessLabel(provider)} installation`}
      aria-busy={pending || info.phase === "updating"}
    >
      {info.label ? (
        <span className="mb-0.5 block text-label font-medium">
          {info.label}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {info.binary ? (
          <details className="min-w-0 text-label">
            <summary
              aria-label={`${info.label ?? harnessLabel(provider)} installation details`}
              className="pressable w-fit cursor-pointer rounded-sm text-foreground marker:text-faint"
            >
              <span className={cn("tabular", view.shimmer && "shimmer")}>
                {view.version}
              </span>
            </summary>
            <p className="mt-1 font-mono text-code break-all text-faint">
              {info.binary}
            </p>
            {info.channel ? (
              <p className="mt-1 text-faint">
                {info.channel === "self"
                  ? "Provider installer"
                  : `Installed via ${info.channel}`}
              </p>
            ) : null}
            {info.latestError ? (
              <p className="mt-1 break-words text-faint">{info.latestError}</p>
            ) : null}
          </details>
        ) : (
          <span className={cn("tabular text-label", view.shimmer && "shimmer")}>
            {view.version}
          </span>
        )}
        {view.action ? (
          <Action
            size="xs"
            tone="outline"
            disabled={pending || updating}
            aria-label={`${view.action.label} ${info.label ?? harnessLabel(provider)}`}
            onClick={() => void runUpdate()}
          >
            {pending
              ? "Updating…"
              : info.result?.outcome === "failed"
                ? "Retry"
                : view.action.label === "Check for updates"
                  ? "Check for updates"
                  : "Update"}
          </Action>
        ) : null}
      </div>
      <span
        role="status"
        className={cn(
          "mt-0.5 block text-label break-words text-faint",
          view.tone === "negative" && "text-removed",
          view.tone === "muted" && "text-muted-foreground"
        )}
      >
        {view.detail}
      </span>
      {info.description ? (
        <span className="mt-0.5 block text-label text-faint">
          {info.description}
        </span>
      ) : null}
      {view.note ? (
        <p role="alert" className="mt-1 text-label text-removed">
          {view.note}
        </p>
      ) : null}
    </div>
  )
}
