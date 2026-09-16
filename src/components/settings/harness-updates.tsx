import { useState } from "react"
import { ListCard, ListCardRow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/lib/harness-label"
import { formatRelative } from "@/lib/format"
import {
  runtimeBusy,
  runtimeCheckedAt,
  runtimeRowView,
  runtimeRows,
} from "@/lib/runtime-updates"
import { providers, useProviders } from "@/state/providers"
import { cn } from "@/lib/utils"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { toast } from "sonner"
import { RefreshCwIcon } from "lucide-react"
import type { HarnessUpdateInfo } from "../../../electron/contracts/harness-updates"

/**
 * The CLI runtimes behind each provider — what is installed, what is current,
 * and who applies the update.
 *
 * Nothing here waits: the host has been reading versions since it started
 * and pushes each change, so the card paints from the store the moment it
 * mounts and a row's words follow the host's reading (`runtimeRowView`).
 * The refresh control asks the host to read everything again; the rows keep
 * their versions while it does. Mako runs an update only when the install
 * channel offers one it can own; app- and registry-managed runtimes name
 * their owner instead.
 */
export function HarnessUpdates() {
  const updates = useProviders((state) => state.runtimeUpdates)
  const rows = runtimeRows(updates)
  const busy = runtimeBusy(updates)
  const checkedAt = runtimeCheckedAt(updates)
  const [pending, setPending] = useState<string | null>(null)

  const runUpdate = async (provider: string) => {
    const label = harnessLabel(provider)
    setPending(provider)
    try {
      const next = await providers.runRuntimeUpdate(provider)
      const result = next.result
      if (!result || result.outcome === "failed")
        toast.error(`${label} was not updated`, {
          description: result?.message ?? "The updater did not finish.",
          duration: ACTION_TOAST_MS,
          action: { label: "Try again", onClick: () => void runUpdate(provider) },
        })
      else if (result.outcome === "updated")
        toast.success(`${label} is now ${result.to ?? "updated"}`, {
          description: "New sessions run on it. Its models were read again.",
        })
      else toast(`${label} is already ${result.to ?? next.installed ?? "current"}`)
    } catch (error) {
      toast.error(`${label} was not updated`, {
        description: error instanceof Error ? error.message : String(error),
        duration: ACTION_TOAST_MS,
        action: { label: "Try again", onClick: () => void runUpdate(provider) },
      })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-label text-faint">Runtime versions</span>
        <span className="flex items-center gap-1.5">
          {checkedAt !== undefined && !busy ? (
            <span className="text-label text-faint">
              checked {formatRelative(checkedAt) === "now" ? "just now" : `${formatRelative(checkedAt)} ago`}
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Check runtime versions again"
            disabled={busy}
            onClick={() => void providers.loadRuntimeUpdates(true)}
            className="pressable flex size-6 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
          >
            <RefreshCwIcon className={cn("size-3", busy && "animate-spin")} />
          </button>
        </span>
      </div>
      <ListCard>
        {rows.map(([provider, info]) => (
          <RuntimeRow
            key={provider}
            provider={provider}
            info={info}
            disabled={pending !== null || info.phase === "updating"}
            onUpdate={() => void runUpdate(provider)}
          />
        ))}
        {rows.length === 0 ? (
          <ListCardRow className="py-2.5 text-ui text-faint">
            {updates === null || busy
              ? "Reading runtime versions…"
              : "No runtimes found on this machine."}
          </ListCardRow>
        ) : null}
      </ListCard>
    </div>
  )
}

function RuntimeRow({
  provider,
  info,
  disabled,
  onUpdate,
}: {
  provider: string
  info: HarnessUpdateInfo
  disabled: boolean
  onUpdate(): void
}) {
  const view = runtimeRowView(info)
  return (
    <ListCardRow className="flex flex-col gap-1 py-2.5">
      <div className="flex items-center gap-3">
        <HarnessIcon harness={provider} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium">{harnessLabel(provider)}</span>
          <span
            className="block truncate text-label text-faint"
            title={info.binary}
          >
            <span className={cn("tabular", view.shimmer && "shimmer")}>{view.version}</span>
            <span
              className={cn(
                view.tone === "negative" && "text-removed",
                view.tone === "muted" && "text-muted-foreground"
              )}
            >
              {" · "}
              {view.detail}
            </span>
          </span>
        </span>
        {view.action ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onUpdate}
            className="pressable shrink-0 rounded-md px-2 py-1 text-ui text-muted-foreground hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
          >
            {view.action.label}
          </button>
        ) : null}
      </div>
      {view.note ? (
        <p className="pl-7 text-label text-removed">{view.note}</p>
      ) : null}
    </ListCardRow>
  )
}
