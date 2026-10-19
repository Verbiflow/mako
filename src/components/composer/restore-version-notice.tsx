import { useEffect, useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Shimmer } from "@/components/ui/shimmer"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { restoreNotice, updateResolves } from "@/lib/restore-plan"
import { activeAcp, useAcp } from "@/state/acp"
import { providers, useProviders } from "@/state/providers"
import { loadRestorePlan, useRestorePlans } from "@/state/restore-plan"
import { useThreads } from "@/state/threads"
import { cn } from "@/lib/utils"

/**
 * Above the composer, while it shows a session its harness deleted that
 * Mako keeps the records of, and the harness here is older than the version
 * that wrote them, or one another program wrote that the build here would
 * import and may not read: the host's restore plan (`RestorePlan`), said
 * before a reply rather than by one. Update runs the update the runtime's plan has,
 * as Settings › Agents does; once the host reads the new version the plan
 * turns native and the line goes. A reply meanwhile goes on from the
 * session's transcript, which the second line says. Nothing shows for a
 * session its harness still has, or when the versions allow the restore.
 */
export function RestoreVersionNotice() {
  useHarnessIdentity()
  const live = useAcp((state) => activeAcp(state) !== null)
  const ref = useThreads((state) => (state.opening ? null : state.viewing?.ref ?? null))
  // Any session but Mako's copy: a kept one restores, and one another program wrote may be imported (a `cursor-agent` store into the Cursor SDK).
  const path = ref && !ref.copyOnly ? ref.path : null
  const plan = useRestorePlans((state) => (path ? state.plans[path] : undefined))
  const updates = useProviders((state) => state.runtimeUpdates)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()

  // Asked again whenever a runtime reading lands: an Update, or one the person ran in a terminal.
  useEffect(() => {
    if (path && !live) void loadRestorePlan(path)
  }, [path, live, updates])

  if (live || !path || plan?.kind !== "update") return null
  const outdated = plan.outdated
  const label = harnessLabel(outdated.harness)
  // An update that can't settle it (nothing names or bounds the writer, or it's another program's records) isn't offered.
  const offer = updateResolves(outdated) ? outdated.offer : { kind: "manual" as const }
  const runtime = offer.kind === "update" ? updates?.[offer.runtimeId] : undefined
  const updating = pending || runtime?.phase === "updating"
  const problem = failure ?? (runtime?.result?.outcome === "failed" ? runtime.result.message : undefined)
  const words = restoreNotice(label, outdated)
  const update = async () => {
    if (offer.kind !== "update") return
    setPending(true)
    setFailure(undefined)
    try {
      const next = await providers.runRuntimeUpdate(offer.runtimeId)
      if (next.result?.outcome === "failed") setFailure(next.result.message ?? "The updater did not finish.")
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
      void loadRestorePlan(path)
    }
  }
  const line = updating ? `Updating ${label}…` : problem ? `${label} wasn't updated: ${problem}` : words.line

  return (
    <div
      role="status"
      data-restore-version-notice={outdated.harness}
      className="mb-1.5 flex items-start gap-2 rounded-md bg-raised px-2 py-1.5 text-ui"
    >
      <HarnessIcon harness={outdated.harness} className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("min-w-0", problem && !updating ? "text-caution" : "text-foreground")}>
          {updating ? <Shimmer text={line} /> : line}
        </span>
        <span className="min-w-0 text-label text-muted-foreground">{words.detail}</span>
        {offer.kind === "manual" && offer.command ? (
          <code data-restore-command className="mt-0.5 min-w-0 truncate font-mono text-label text-faint" title={offer.command}>
            {offer.command}
          </code>
        ) : null}
      </div>
      {offer.kind === "update" ? (
        <button
          type="button"
          disabled={updating}
          onClick={() => void update()}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover disabled:opacity-60"
        >
          {problem ? "Try again" : `Update ${label}`}
        </button>
      ) : offer.kind === "owner" && offer.owner === "Mako" ? (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "updates" }))}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          Updates
        </button>
      ) : offer.kind === "manual" && offer.command ? (
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(offer.command ?? "")}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          Copy command
        </button>
      ) : null}
    </div>
  )
}
