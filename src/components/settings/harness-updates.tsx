import { useEffect, useState } from "react"
import { ListCard, ListCardRow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/lib/harness-label"
import { providers, useProviders } from "@/state/providers"
import { toast } from "sonner"
import { CheckIcon, RefreshCwIcon } from "lucide-react"

/**
 * The CLI runtimes behind each provider — what is installed, what is current,
 * and who applies the update. Mako runs the update only when the install
 * channel offers one it can own; app- and registry-managed runtimes name
 * their owner instead.
 */
export function HarnessUpdates() {
  const updates = useProviders((state) => state.runtimeUpdates)
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)

  const load = async () => {
    setChecking(true)
    try {
      await providers.loadRuntimeUpdates()
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void providers.loadRuntimeUpdates()
  }, [])

  const runUpdate = async (provider: string, label: string) => {
    setUpdating(provider)
    try {
      const next = await providers.runRuntimeUpdate(provider)
      toast(
        next.installed
          ? `${harnessLabel(provider)} is now ${next.installed}`
          : `${label} finished`
      )
    } catch (error) {
      toast.error(`Could not update ${harnessLabel(provider)}`, {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setUpdating(null)
    }
  }

  const entries = Object.entries(updates ?? {}).filter(
    ([, info]) => info.binary || info.error
  )

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-label text-faint">Runtime versions</span>
        <button
          type="button"
          aria-label="Check for runtime updates"
          disabled={checking}
          onClick={() => void load()}
          className="pressable flex size-6 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
        >
          <RefreshCwIcon className={`size-3 ${checking ? "animate-spin" : ""}`} />
        </button>
      </div>
      <ListCard>
        {entries.map(([provider, info]) => {
          const behind =
            info.installed && info.latest && info.installed !== info.latest
          const version = info.installed
            ? behind
              ? `${info.installed} → ${info.latest}`
              : info.installed
            : "version unknown"
          const detail = info.error
            ? info.error
            : info.managedBy
              ? `Updates come from ${info.managedBy}`
              : info.binary
          return (
            <ListCardRow key={provider} className="flex items-center gap-3 py-2.5">
              <HarnessIcon harness={provider} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium">
                  {harnessLabel(provider)}
                </span>
                <span className="block truncate text-label text-faint" title={info.binary}>
                  {version}
                  {detail && !info.error && info.managedBy ? ` · ${detail}` : ""}
                </span>
              </span>
              {info.update ? (
                <button
                  type="button"
                  disabled={updating !== null}
                  onClick={() => void runUpdate(provider, info.update!.label)}
                  className="pressable shrink-0 rounded-md px-2 py-1 text-ui text-muted-foreground hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
                >
                  {updating === provider ? "Updating…" : behind ? info.update.label : "Update anyway"}
                </button>
              ) : behind || info.installed ? (
                <span className={`shrink-0 flex items-center gap-1 text-label ${behind ? "text-muted-foreground" : "text-faint"}`}>
                  {!behind && <CheckIcon className="size-3" />}
                  {behind ? "Update available" : "Current"}
                </span>
              ) : null}
            </ListCardRow>
          )
        })}
        {entries.length === 0 && !checking ? (
          <ListCardRow className="py-2.5 text-ui text-faint">
            No runtimes found on this machine.
          </ListCardRow>
        ) : null}
      </ListCard>
    </div>
  )
}
