import { useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Shimmer } from "@/components/ui/shimmer"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { tooOld, tooOldText } from "@/lib/runtime-versions"
import { activeAcp, useAcp } from "@/state/acp"
import { providers, useProviders } from "@/state/providers"
import { useThreads } from "@/state/threads"
import { cn } from "@/lib/utils"

/**
 * One line above the composer when the harness a reply would run under is
 * older than Mako's client speaks: the one version case that stops a
 * session, said when the harness is picked rather than by a failed send.
 * Update runs the same update Settings › Agents offers, to the version Mako
 * has tested, and the line goes away by itself once the reading is fine.
 *
 * A version newer than Mako has tested, or one Mako couldn't read, says
 * nothing here. Registered on `composer.above`; routes the way the composer
 * does: the live session's harness, then the thread on screen, then the
 * composer's own choice for a new thread.
 */
export function RuntimeVersionNotice() {
  useHarnessIdentity()
  const liveHarness = useAcp((state) => activeAcp(state)?.harness ?? null)
  const routedHarness = useThreads(
    (state) => state.opening?.ref.harness ?? state.viewing?.ref.harness ?? null
  )
  const newHarness = useThreads((state) => state.composerHarness)
  const harness = liveHarness ?? routedHarness ?? newHarness
  const updates = useProviders((state) => state.runtimeUpdates)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()

  const runtime = tooOld(updates, harness)
  if (!runtime || !harness) return null
  const label = harnessLabel(harness)
  const updating = pending || runtime.updating
  const problem = failure ?? runtime.failure
  const update = async () => {
    setPending(true)
    setFailure(undefined)
    try {
      const next = await providers.runRuntimeUpdate(runtime.id)
      if (next.result?.outcome === "failed")
        setFailure(next.result.message ?? "The updater did not finish.")
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  const text = updating
    ? `Updating ${label}…`
    : problem
      ? `${label} wasn't updated: ${problem}`
      : `${tooOldText(label, runtime)}${runtime.update ? "" : ` ${runtime.owner}`}`

  return (
    <div
      role="status"
      data-runtime-version-notice={harness}
      className={cn(
        "mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-ui",
        updating ? "text-muted-foreground" : "text-caution"
      )}
    >
      <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {updating ? <Shimmer text={text} /> : text}
      </span>
      {runtime.update ? (
        <button
          type="button"
          disabled={updating}
          onClick={() => void update()}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover disabled:opacity-60"
        >
          {problem ? "Try again" : "Update"}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          Settings
        </button>
      )}
    </div>
  )
}
