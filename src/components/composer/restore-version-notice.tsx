import { useEffect, useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { restoreNotice, updateResolves } from "@/lib/restore-plan"
import { activeAcp, useAcp } from "@/state/acp"
import { providers, useProviders } from "@/state/providers"
import { loadRestorePlan, useRestorePlans } from "@/state/restore-plan"
import { useThreads } from "@/state/threads"
import type { ComposerNotice } from "@/extend/notices"

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
export function useRestoreVersionNotice(): ComposerNotice | null {
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
  const line = updating ? `Updating ${label}…` : problem ? `${label} wasn't updated` : words.line
  const settings = (detail: string) => () => window.dispatchEvent(new CustomEvent("mako:settings", { detail }))
  const action =
    offer.kind === "update"
      ? { label: problem ? "Try again" : `Update ${label}`, primary: true, disabled: updating, onClick: () => void update() }
      : offer.kind === "owner" && offer.owner === "Mako"
        ? { label: "Updates", onClick: settings("updates") }
        : offer.kind === "manual" && offer.command
          ? { label: "Copy command", onClick: () => void navigator.clipboard.writeText(offer.command ?? "") }
          : undefined
  return {
    id: "restore-version",
    tone: updating ? "progress" : "caution",
    icon: <HarnessIcon harness={outdated.harness} />,
    title: line,
    description: problem && !updating ? problem : undefined,
    detail: (
      <>
        <p>{words.detail}</p>
        {offer.kind === "manual" && offer.command ? (
          <code data-restore-command className="mt-1.5 block font-mono text-label break-all text-foreground">{offer.command}</code>
        ) : null}
      </>
    ),
    actions: action ? [action] : undefined,
    data: { "data-restore-version-notice": outdated.harness },
  }
}
