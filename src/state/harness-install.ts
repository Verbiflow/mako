import { accounts, accountsStore, useAccounts } from "@/state/accounts"
import { providers } from "@/state/providers"
import { connectionFor, providerConnections, useProviderConnections } from "@/state/provider-connections"
import type { HarnessUpdateInfo } from "@mako/host/contracts/harness-updates"

/**
 * Installs a harness from wherever the person asked for it (Settings › Agents, the harness picker, the line above
 * the composer), then reads its sign-in again, so the next step each of them offers is signing in to what was just
 * installed. The host's reading carries the progress and the outcome to every window.
 */
export async function installHarness(harness: string): Promise<HarnessUpdateInfo> {
  const next = await providers.runRuntimeInstall(harness)
  if (next.result?.outcome === "installed")
    await Promise.all([accounts.reload(), providerConnections.reload()]).catch(() => undefined)
  return next
}

/**
 * How a harness signs in from Mako, when it has a sign-in Mako can start and nobody is signed in: `account`, the
 * harness's own login run by the host and finished in its Settings row (Claude Code, Codex, Cursor, Grok, Devin);
 * `browser`, a connection signed in through the browser (the line above the composer already offers it). Undefined
 * for a harness that's signed in, or one that asks inside a conversation or through its own models (Antigravity,
 * OpenCode).
 */
export function useSignInNeeded(harness: string | null | undefined): "account" | "browser" | undefined {
  const connection = useProviderConnections((state) => (harness ? connectionFor(state, harness) : undefined))
  const provider = useAccounts((state) => state.providers.find((entry) => entry.provider === harness))
  const signedIn = useAccounts((state) => state.accounts.some((account) => account.harness === harness && !account.missing))
  const loaded = useAccounts((state) => state.loadedAt !== undefined)
  if (!harness) return undefined
  if (connection) return connection.state.status === "signed-out" ? "browser" : undefined
  if (!loaded || signedIn || provider?.mode !== "selectable" || provider.nativeLogin !== true) return undefined
  return "account"
}

/** Starts the harness's own sign-in in its Settings › Agents row, which opens to show it. */
export function signInToHarness(harness: string): void {
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))
  if (accountsStore.get().signIn?.harness === harness) return
  void accounts.signIn(harness)
}
