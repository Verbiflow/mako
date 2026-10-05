import { useState } from "react"
import { CheckIcon, ChevronDownIcon, EllipsisIcon, KeyRoundIcon, PlusIcon } from "lucide-react"
import { Action, IconAction } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { ProviderIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import type { UtilityConnection, UtilityProvider, UtilityProviderInfo } from "@/lib/types"
import { chooseCommitModel, refreshCommitModel, useCommitModelSettings } from "@/state/commit-model"
import { utilityModels } from "@/state/model-runtime"
import { ConnectModel } from "./connect-model"

/**
 * The API keys commit messages are written with. Each connected key is a
 * row; the checked one writes them, and with several, choosing a row moves
 * the check. Keys are added from one menu of the providers not yet
 * connected, so the list holds only what the person has.
 */
export function CommitKeys() {
  const { settings, error } = useCommitModelSettings()
  const [editing, setEditing] = useState<{ provider: UtilityProviderInfo; connection?: UtilityConnection } | null>(null)
  const [removing, setRemoving] = useState<UtilityProvider | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const run = async (work: () => Promise<void>, fallback: string) => {
    try {
      await work()
      setFailure(null)
      await refreshCommitModel()
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : fallback)
    }
  }

  if (!settings) return <p role="status" className="text-label text-faint">{error ?? "Loading API keys…"}</p>

  const commit = settings.work?.commit
  const active = commit?.resolved?.id
  const connections = settings.connections
  const unconnected = settings.providers.filter((provider) => !connections.some((entry) => entry.provider === provider.id))
  const locked = !settings.secureStorage
  const providerOf = (id: UtilityProvider) => settings.providers.find((provider) => provider.id === id)
  const connect = (provider: UtilityProviderInfo) => setEditing({ provider })

  return (
    <div className="flex flex-col gap-2">
      {failure ? (
        <div role="alert" className="flex items-center gap-3 text-label text-negative">
          <span className="flex-1">{failure}</span>
          <Action size="xs" onClick={() => setFailure(null)}>Dismiss</Action>
        </div>
      ) : null}
      {locked ? (
        <p role="alert" className="text-label text-caution">Your keychain is locked, so Mako can't store a key. Unlock it to connect one.</p>
      ) : null}
      {commit && !commit.resolved && connections.length > 0 && commit.reason ? (
        <p role="alert" className="text-label text-caution">{commit.reason}</p>
      ) : null}
      <div role="radiogroup" aria-label="API key that writes commit messages" className="rounded-lg bg-shell/55 [box-shadow:inset_0_0_0_0.5px_var(--hairline)] divide-y divide-hairline">
        {connections.length === 0 ? (
          <div className="flex items-center gap-4 px-4 py-4">
            <KeyTile />
            <div className="min-w-0 flex-1">
              <p className="text-ui font-medium">No API key yet</p>
              <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
                Generate calls the provider directly with your key. OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint, including a local model.
              </p>
            </div>
            <ConnectMenu providers={settings.providers} disabled={locked} label="Connect API key" tone="outline" onPick={connect} />
          </div>
        ) : connections.map((connection) => {
          const provider = providerOf(connection.provider)
          const id = `${connection.provider}/${connection.model}`
          const used = active === id
          const issue = settings.issues.find((entry) => entry.provider === connection.provider)
          return (
            <div key={connection.provider} className="flex flex-col">
              <div className="flex items-center gap-3 py-2.5 pr-2.5 pl-4">
                <button
                  type="button"
                  role="radio"
                  aria-checked={used}
                  aria-label={`${connection.model}, ${provider?.name ?? connection.provider}`}
                  onClick={() => { if (!used) void chooseCommitModel(id) }}
                  className={cn("pressable flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-border", used && "cursor-default")}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-raised [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
                    <ProviderIcon provider={connection.provider} tinted={false} className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium">{connection.model}</span>
                    <span className="block truncate text-label text-faint">
                      {provider?.name ?? connection.provider}{connection.baseUrl ? ` · ${endpoint(connection.baseUrl)}` : ""}
                    </span>
                  </span>
                  {used ? (
                    <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
                      <CheckIcon className="size-3.5" />
                      Writes commit messages
                    </span>
                  ) : (
                    <span className="shrink-0 text-label text-faint">Use this key</span>
                  )}
                </button>
                <Menu modal={false}>
                  <MenuTrigger asChild>
                    <IconAction size="xs" label={`${provider?.name ?? connection.provider} key options`}>
                      <EllipsisIcon />
                    </IconAction>
                  </MenuTrigger>
                  <MenuContent align="end" className="min-w-48">
                    <MenuItem disabled={locked || !provider} onSelect={() => provider && setEditing({ provider, connection })}>Change model or key…</MenuItem>
                    <MenuItem className="text-negative" onSelect={() => setRemoving(connection.provider)}>Remove key</MenuItem>
                  </MenuContent>
                </Menu>
              </div>
              {issue ? <p className="pb-2.5 pl-14 text-label text-caution">{issue.message}</p> : null}
              {removing === connection.provider ? (
                <div className="flex flex-wrap items-center gap-2 pr-2.5 pb-2.5 pl-14 text-label text-muted-foreground">
                  <span className="flex-1">Remove this key from this Mac?</span>
                  <Action size="xs" onClick={() => setRemoving(null)}>Keep</Action>
                  <Action
                    size="xs"
                    tone="danger"
                    onClick={() => void run(async () => {
                      await utilityModels.disconnect(connection.provider)
                      setRemoving(null)
                    }, "The key could not be removed. Try again.")}
                  >
                    Remove
                  </Action>
                </div>
              ) : null}
            </div>
          )
        })}
        {connections.length > 0 && unconnected.length > 0 ? (
          <div className="px-2 py-1.5">
            <ConnectMenu providers={unconnected} disabled={locked} label="Add another key" tone="ghost" onPick={connect} />
          </div>
        ) : null}
      </div>
      {editing ? (
        <ConnectModel
          key={editing.provider.id}
          provider={editing.provider}
          connection={editing.connection}
          onClose={() => setEditing(null)}
          onConnected={(connection) => {
            setEditing(null)
            void chooseCommitModel(`${connection.provider}/${connection.model}`)
          }}
        />
      ) : null}
    </div>
  )
}

function KeyTile() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised text-faint [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      <KeyRoundIcon className="size-4" />
    </span>
  )
}

function ConnectMenu({ providers, disabled, label, tone, onPick }: {
  providers: readonly UtilityProviderInfo[]
  disabled: boolean
  label: string
  tone: "outline" | "ghost"
  onPick(provider: UtilityProviderInfo): void
}) {
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <Action size="xs" tone={tone} disabled={disabled} aria-label={label} className="shrink-0">
          <PlusIcon />
          {label}
          <ChevronDownIcon className="text-faint" />
        </Action>
      </MenuTrigger>
      <MenuContent align={tone === "outline" ? "end" : "start"} className="w-72">
        {providers.map((provider) => (
          <MenuItem key={provider.id} onSelect={() => onPick(provider)} className="items-start py-2">
            <ProviderIcon provider={provider.id} tinted={false} className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-ui">{provider.name}</span>
              <span className="block text-label text-faint">{provider.description}</span>
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

/** An endpoint's host, as a row names it. */
function endpoint(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
