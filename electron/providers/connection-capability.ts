import type {
  ProviderConnection,
  ProviderConnectionAction,
  ProviderConnectionState,
} from "../contracts/provider-connection.js"
import type { ProviderCapability } from "./registry.js"

/**
 * A provider-owned sign-in for one of its transports. Credentials stay in
 * the provider's own store; the host sees state, never a key, and the
 * renderer sees only what `describeConnection` projects.
 */
export interface ProviderConnectionCapability extends ProviderCapability {
  label: string
  description: string
  /** Where a pasted key is made. */
  keyUrl?: string
  actions?: ProviderConnection["actions"]
  /** Whether this host can save a key at all. */
  secureStorage(): Promise<boolean>
  /** The remembered state; `refresh` asks the provider again. */
  status(
    refresh?: boolean
  ): Promise<ProviderConnectionState & { checkedAt?: string }>
  /** Runs one action; resolves when its effect is recorded. */
  act(
    action: Exclude<ProviderConnectionAction, { kind: "refresh" }>
  ): Promise<ProviderConnectionState>
  /** Fires when the state changes for any reason, including a sign-in from Settings. */
  onChange?(listener: () => void): () => void
}

export async function describeConnection(
  capability: ProviderConnectionCapability,
  refresh = false
): Promise<ProviderConnection> {
  const [status, storage] = await Promise.allSettled([
    capability.status(refresh),
    capability.secureStorage(),
  ])
  const { checkedAt, ...state } =
    status.status === "fulfilled"
      ? status.value
      : {
          status: "unavailable" as const,
          message: `Couldn’t check ${capability.label}’s connection. Refresh to try again.`,
          checkedAt: undefined,
        }
  const connection: ProviderConnection = {
    provider: capability.provider,
    label: capability.label,
    description: capability.description,
    state,
    secureStorage: storage.status === "fulfilled" && storage.value,
    actions: capability.actions,
  }
  if (capability.keyUrl) connection.keyUrl = capability.keyUrl
  if (checkedAt) connection.checkedAt = checkedAt
  return connection
}
