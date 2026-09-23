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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            "tabular text-label text-faint",
            view.shimmer && "shimmer"
          )}
        >
          {info.installed ? `Version ${view.version}` : view.version}
        </span>
        <span aria-hidden="true" className="text-label text-faint">
          ·
        </span>
        <span
          role="status"
          className={cn(
            "min-w-0 flex-1 text-label text-faint",
            view.tone === "negative" && "text-removed",
            view.tone === "muted" && "text-muted-foreground"
          )}
        >
          {view.detail}
        </span>
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
                : view.action.label === "Check and update"
                  ? "Check and update"
                  : "Update"}
          </Action>
        ) : null}
      </div>
      {view.note ? (
        <p role="alert" className="mt-1 text-label text-removed">
          {view.note}
        </p>
      ) : null}
    </div>
  )
}

/** Technical provenance is available on demand, away from connection and update actions. */
export function InstallationDetails({ info }: { info: HarnessUpdateInfo }) {
  return (
    <div className="space-y-1 text-label text-faint">
      <span className="font-medium text-muted-foreground">Installation</span>
      {info.managedBy ? (
        <p>
          This copy is included with {info.managedBy.replace(/\.app$/, "")}.
          Update that app to update this copy.
        </p>
      ) : null}
      {info.binary ? (
        <p className="font-mono text-code break-all">{info.binary}</p>
      ) : null}
      {info.channel && info.channel !== "app" && info.channel !== "managed" ? (
        <p>
          {info.channel === "self"
            ? "Updated by the CLI’s own installer"
            : info.channel === "manual"
              ? "Installed manually"
              : `Installed with ${info.channel}`}
        </p>
      ) : null}
      {info.latestError ? (
        <p className="break-words">{info.latestError}</p>
      ) : null}
    </div>
  )
}
