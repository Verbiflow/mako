import { HarnessIcon } from "@/components/ui/provider-icon"
import { activeAcp, useAcp } from "@/state/acp"
import { connectionFor, providerConnections, useProviderConnections } from "@/state/provider-connections"
import { useThreads } from "@/state/threads"
import { cn } from "@/lib/utils"

/**
 * One line above the composer when the provider a reply would run under is
 * signed out of its own transport. It says what will happen (the reply asks
 * for a browser sign-in) rather than blocking the send, offers the sign-in
 * here, and names a rejected key so the user learns about it before the
 * next prompt fails, not from the failure.
 *
 * Registered on `composer.above`; reads the same slice the composer uses to
 * route a reply — the live session's harness, then the thread on screen,
 * then the composer's own choice for a new thread.
 */
export function ProviderConnectionNotice() {
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
  const text = failure
    ? failure.message
    : problem
      ? problem.message
      : `${connection.label} is not signed in — a reply asks you to sign in with the browser.`

  return (
    <div
      role="status"
      className={cn(
        "mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-ui",
        problem || failure ? "text-caution" : "text-muted-foreground"
      )}
    >
      <HarnessIcon harness={connection.provider} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{working ? "Waiting for the browser…" : text}</span>
      {connection.secureStorage ? (
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void providerConnections.act(connection.provider, { kind: "sign-in-browser" })}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover disabled:opacity-60"
        >
          Sign in
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))}
        className="pressable shrink-0 rounded px-1.5 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        Settings
      </button>
    </div>
  )
}
