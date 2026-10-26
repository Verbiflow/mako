import { useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { tooOld, tooOldText } from "@/lib/runtime-versions"
import { activeAcp, useAcp } from "@/state/acp"
import { providers, useProviders } from "@/state/providers"
import { useThreads } from "@/state/threads"
import type { ComposerNotice } from "@/extend/notices"

/**
 * One line above the composer when the harness a reply would run under is
 * older than Mako's client speaks: the one version case that stops a
 * session, said when the harness is picked rather than by a failed send.
 * Update runs the same update Settings › Agents offers, to the version Mako
 * has tested, and the line goes away by itself once the reading is fine.
 *
 * A version newer than Mako has tested, or one Mako couldn't read, says
 * nothing here. A notice producer (`registerNotice`); routes the way the composer
 * does: the live session's harness, then the thread on screen, then the
 * composer's own choice for a new thread.
 */
export function useRuntimeVersionNotice(): ComposerNotice | null {
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
  const text = tooOldText(label, runtime)
  return {
    id: "runtime-version",
    tone: updating ? "progress" : "caution",
    icon: <HarnessIcon harness={harness} />,
    title: updating ? `Updating ${label}…` : problem ? `${label} wasn't updated` : `${label} ${runtime.installed} is too old for Mako`,
    description: updating ? undefined : problem ?? (runtime.oldest ? `needs ${runtime.oldest} or newer` : undefined),
    detail: updating ? undefined : <p>{text}{runtime.update ? "" : ` ${runtime.owner}`}</p>,
    actions: [
      runtime.update
        ? { label: problem ? "Try again" : "Update", primary: true, disabled: updating, onClick: () => void update() }
        : { label: "Settings", onClick: () => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" })) },
    ],
    data: { "data-runtime-version-notice": harness },
  }
}
