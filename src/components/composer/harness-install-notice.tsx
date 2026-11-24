import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { installPlanText, justInstalled, missingHarness } from "@/lib/harness-install"
import { activeAcp, useAcp } from "@/state/acp"
import { installHarness, signInToHarness, useSignInNeeded } from "@/state/harness-install"
import { providers, useProviders } from "@/state/providers"
import { useThreads } from "@/state/threads"
import type { ComposerNotice } from "@/extend/notices"

/**
 * One line above the composer when the harness a reply would run under isn't installed: Install runs the same
 * install Settings › Agents offers, at the version Mako is tested with, and the line follows it through to the
 * harness's sign-in, then goes away by itself. A failure says why with Try again; a machine none of the harness's
 * installers runs on says so with Check again, for once it's installed another way. A sign-in through the browser
 * is the connection line's (`connection-notice.tsx`), so this one leaves it.
 *
 * A notice producer (`registerNotice`); routes the way the composer does: the live session's harness, then the
 * thread on screen, then the composer's own choice for a new thread.
 */
export function useHarnessInstallNotice(): ComposerNotice | null {
  useHarnessIdentity()
  const liveHarness = useAcp((state) => activeAcp(state)?.harness ?? null)
  const routedHarness = useThreads((state) => state.opening?.ref.harness ?? state.viewing?.ref.harness ?? null)
  const newHarness = useThreads((state) => state.composerHarness)
  const harness = liveHarness ?? routedHarness ?? newHarness
  const updates = useProviders((state) => state.runtimeUpdates)
  const signIn = useSignInNeeded(harness)
  if (!harness) return null
  const label = harnessLabel(harness)
  const icon = <HarnessIcon harness={harness} />
  const data = { "data-harness-install": harness }

  if (justInstalled(updates, harness) && signIn === "account")
    return {
      id: "harness-install",
      tone: "info",
      icon,
      title: `${label} is installed`,
      description: "sign in to use it",
      actions: [{ label: "Sign in", primary: true, onClick: () => signInToHarness(harness) }],
      data: { ...data, "data-harness-install-step": "sign-in" },
    }

  const missing = missingHarness(updates, harness)
  if (!missing) return null
  const { install } = missing
  if (missing.installing)
    return {
      id: "harness-install",
      tone: "progress",
      icon,
      title: `Installing ${label}…`,
      description: missing.installs,
      data: { ...data, "data-harness-install-step": "installing" },
    }
  if (!install)
    return {
      id: "harness-install",
      tone: "caution",
      icon,
      title: `${label} isn't installed`,
      description: "Mako can't install it here",
      detail: <p>None of the ways Mako installs {label} works here. Install it from its website, then check again.</p>,
      actions: [{ label: "Check again", primary: true, onClick: () => void providers.loadRuntimeUpdates(true) }],
      data: { ...data, "data-harness-install-step": "unavailable" },
    }
  return {
    id: "harness-install",
    tone: "caution",
    icon,
    title: missing.failure ? `${label} wasn't installed` : `${label} isn't installed`,
    description: missing.failure ?? (missing.installs ? `installs ${missing.installs}, the version Mako is tested with` : undefined),
    detail: <p>{install.summary ?? <>Runs <code className="font-mono break-all">{installPlanText(install)}</code></>}</p>,
    actions: [{ label: missing.failure ? "Try again" : "Install", primary: true, onClick: () => void installHarness(harness) }],
    data: { ...data, "data-harness-install-step": missing.failure ? "failed" : "install" },
  }
}
