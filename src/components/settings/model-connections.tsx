import { useState } from "react"
import { CheckIcon, PlusIcon } from "lucide-react"
import { Action } from "@/components/ui/kit"
import { ProviderIcon } from "@/components/ui/provider-icon"
import type { UtilityModelSettings, UtilityProvider, UtilityProviderInfo } from "@/lib/types"
import { utilityModels } from "@/state/model-runtime"
import { ConnectModel } from "./connect-model"

/**
 * API keys for providers Mako can draft with directly, beside the harnesses.
 * Connecting one makes it the drafting model; the picker above can switch
 * back to Automatic. The settings are that picker's, so the two never disagree.
 */
export function ModelConnections({ settings, refresh, choose }: {
  settings: UtilityModelSettings | null
  refresh: () => Promise<void>
  choose: (choice: string) => Promise<void>
}) {
  const [editing, setEditing] = useState<UtilityProviderInfo | null>(null)
  const [disconnecting, setDisconnecting] = useState<UtilityProvider | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (work: () => Promise<void>, failure: string) => {
    try {
      await work()
      setError(null)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure)
    }
  }

  const drafting = settings?.work?.commit?.resolved?.id

  return (
    <section aria-label="Model connections" className="mt-2 flex flex-col gap-3">
      <div>
        <h4 className="text-ui font-medium">API connections</h4>
        <p className="mt-0.5 text-label text-muted-foreground">
          Draft with a provider's API key instead of a harness. The key stays in this Mac's key store.
        </p>
      </div>
      {error ? (
        <div role="alert" className="flex items-center gap-3 text-label text-negative">
          <span className="flex-1">{error}</span>
          <Action size="xs" onClick={() => setError(null)}>Dismiss</Action>
        </div>
      ) : null}
      {!settings ? <p role="status" className="text-label text-faint">Loading model connections…</p> : null}
      {settings && !settings.secureStorage ? (
        <p role="alert" className="text-label text-caution">
          Secure key storage is unavailable. Unlock your system keychain to connect a model.
        </p>
      ) : null}
      {settings ? (
        <div className="divide-y divide-hairline rounded-lg border border-hairline px-3">
          {settings.providers.map((provider) => {
            const connection = settings.connections.find((entry) => entry.provider === provider.id)
            const used = connection && drafting === `${connection.provider}/${connection.model}`
            const issue = settings.issues.find((entry) => entry.provider === provider.id)
            return (
              <div key={provider.id} className="flex flex-col gap-2 py-3">
                <div className="flex items-center gap-3">
                  <ProviderIcon provider={provider.id} tinted={false} className="size-5" />
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-ui font-medium">
                      {provider.name}
                      {used ? (
                        <span className="flex items-center gap-1 text-label font-normal text-faint">
                          <CheckIcon className="size-3" />
                          Writes commits and pull requests
                        </span>
                      ) : null}
                    </span>
                    <p className="mt-0.5 truncate text-label text-faint">{connection?.model ?? provider.description}</p>
                  </div>
                  <Action
                    tone={connection ? "ghost" : "outline"}
                    disabled={!settings.secureStorage}
                    onClick={() => setEditing(provider)}
                    aria-label={`${connection ? "Edit" : "Connect"} ${provider.name}`}
                  >
                    {connection ? null : <PlusIcon />}
                    {connection ? "Edit" : "Connect"}
                  </Action>
                  {connection ? (
                    <Action size="xs" onClick={() => setDisconnecting(provider.id)} aria-label={`Disconnect ${provider.name}`}>
                      Disconnect
                    </Action>
                  ) : null}
                </div>
                {issue ? <p className="pl-8 text-label text-caution">{issue.message}</p> : null}
                {disconnecting === provider.id ? (
                  <div className="flex flex-wrap items-center gap-2 pl-8 text-label text-muted-foreground">
                    <span className="flex-1">Remove this device's saved connection?</span>
                    <Action size="xs" onClick={() => setDisconnecting(null)}>Keep</Action>
                    <Action
                      size="xs"
                      tone="danger"
                      onClick={() => void run(async () => {
                        await utilityModels.disconnect(provider.id)
                        setDisconnecting(null)
                      }, "The connection could not be removed. Try again.")}
                    >
                      Remove connection
                    </Action>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      {editing ? (
        <ConnectModel
          key={editing.id}
          provider={editing}
          connection={settings?.connections.find((entry) => entry.provider === editing.id)}
          onClose={() => setEditing(null)}
          onConnected={(connection) => {
            setEditing(null)
            void choose(`${connection.provider}/${connection.model}`)
          }}
        />
      ) : null}
    </section>
  )
}
