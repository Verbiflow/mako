import { HarnessIcon } from "@/components/ui/provider-icon"
import { activeAcp, useAcp } from "@/state/acp"
import { connectionFor, providerConnections, useProviderConnections } from "@/state/provider-connections"
import { useThreads } from "@/state/threads"
import type { ComposerNotice } from "@/extend/notices"

/**
 * One line above the composer when the provider a reply would run under is
 * signed out of its own transport. It says what will happen (the reply asks
 * for a browser sign-in) rather than blocking the send, offers the sign-in
 * here, and names a rejected key so the user learns about it before the
 * next prompt fails, not from the failure.
 *
 * A notice producer (`registerNotice`); reads the same slice the composer uses to
 * route a reply — the live session's harness, then the thread on screen,
 * then the composer's own choice for a new thread.
 */
export function useProviderConnectionNotice(): ComposerNotice | null {
  const liveHarness = useAcp((state) => activeAcp(state)?.harness ?? null)
  const routedHarness = useThreads(
    (state) => state.opening?.ref.harness ?? state.viewing?.ref.harness ?? null
  )
  const newHarness = useThreads((state) => state.composerHarness)
  const harness = liveHarness ?? routedHarness ?? newHarness
  const connection = useProviderConnections((state) => connectionFor(state, harness))
  const busy = useProviderConnections((state) => state.busy)
  const failure = useProviderConnections((state) =>
    harness ? state.failures[harness] : undefined
  )

  if (!connection || connection.state.status !== "signed-out") return null
  const problem = connection.state.problem
  const working = busy?.provider === connection.provider
  const reason = failure?.message ?? problem?.message

  const settings = { label: "Settings", onClick: () => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" })) }
  return {
    id: "provider-connection",
    tone: working ? "progress" : reason ? "caution" : "info",
    icon: <HarnessIcon harness={connection.provider} />,
    title: working ? "Waiting for the browser…" : `${connection.label} is signed out`,
    description: working ? undefined : reason ?? "a reply asks you to sign in with the browser",
    actions: (connection.actions?.includes("sign-in-browser") ?? connection.secureStorage)
      ? [{ label: "Sign in", primary: true, disabled: Boolean(busy), onClick: () => void providerConnections.act(connection.provider, { kind: "sign-in-browser" }) }, settings]
      : [settings],
    data: { "data-provider-connection": connection.provider },
  }
}
