import { formatRelative } from "@/lib/format"
import type { ProviderConnection } from "@/lib/types"

/** One line of where the credential lives and how long it is good for. */
export function connectionStatusText(connection: ProviderConnection): string {
  const { state } = connection
  if (state.status === "unavailable") return "Connection unavailable"
  if (state.status === "signed-out") return "Not signed in"
  const who = state.account ? `Signed in as ${state.account}` : "Signed in"
  const via =
    state.source === "env"
      ? "using a configured API key"
      : state.source === "cli"
        ? `using ${connection.label}’s CLI login`
        : state.source === "sdk"
          ? `using ${connection.label}’s SDK login`
          : state.method === "pasted"
            ? state.keyName
              ? `with the key “${state.keyName}”`
              : "with a pasted key"
            : "from Mako's browser sign-in"
  const expiry = state.expiresAt
    ? `expires ${formatRelative(state.expiresAt)}`
    : null
  return [who, via, expiry].filter(Boolean).join(" · ")
}
