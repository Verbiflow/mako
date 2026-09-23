import { useState } from "react"
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react"
import { Action } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { providers, useProviders } from "@/state/providers"
import { accounts, useAccounts } from "@/state/accounts"
import {
  connectionFor,
  providerConnections,
  useProviderConnections,
} from "@/state/provider-connections"
import {
  ConnectionControls,
  ConnectionKeyForm,
  ConnectionNotes,
  ConnectionStatus,
} from "./provider-connections"
import { ProviderAccounts } from "./provider-accounts"
import { RuntimeRow, InstallationDetails } from "./harness-updates"
import { runtimeBusy, runtimeRows } from "@/lib/runtime-updates"
import { cn } from "@/lib/utils"

interface Agent {
  id: string
  name: string
  how: string
}

export function ProviderTable({
  harnesses,
  availability,
}: {
  harnesses: Agent[]
  availability: Record<string, boolean> | null
}) {
  const updates = useProviders((state) => state.runtimeUpdates)
  const busy = runtimeBusy(updates)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try {
      accounts.load(true)
      providerConnections.load(true)
      await Promise.all([
        providers.loadRuntimeUpdates(true),
        providers.loadAll(true).then(() => providers.loadStatus()),
      ])
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <div className="@container">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-ui font-medium">Your agents</span>
        <Action
          size="xs"
          disabled={refreshing || busy}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon
            className={cn(
              (refreshing || busy) && "animate-spin motion-reduce:animate-none"
            )}
          />
          {refreshing || busy ? "Checking…" : "Refresh"}
        </Action>
      </div>
      <div
        role="list"
        aria-label="Agent connections"
        className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline"
      >
        {harnesses.map((agent) => (
          <ProviderRow
            key={agent.id}
            agent={agent}
            installed={
              availability === null ? null : Boolean(availability[agent.id])
            }
          />
        ))}
      </div>
    </div>
  )
}

function ProviderRow({
  agent,
  installed,
}: {
  agent: Agent
  installed: boolean | null
}) {
  const connection = useProviderConnections((state) =>
    connectionFor(state, agent.id)
  )
  const connectionBusy = useProviderConnections((state) => state.busy)
  const connectionLoaded = useProviderConnections((state) => state.loadedAt)
  const accountProvider = useAccounts((state) =>
    state.providers.find((provider) => provider.provider === agent.id)
  )
  const providerAccounts = useAccounts((state) =>
    state.accounts.filter((account) => account.harness === agent.id)
  )
  const accountsLoaded = useAccounts((state) => state.loadedAt)
  const updates = useProviders((state) => state.runtimeUpdates)
  const runtimes = runtimeRows(updates)
    .filter(([id, info]) => (info.provider ?? id) === agent.id)
    .sort(
      ([, a], [, b]) => Number(Boolean(b.primary)) - Number(Boolean(a.primary))
    )
  const primary = runtimes[0]
  const [expanded, setExpanded] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const selected = providerAccounts.find((account) => account.active)
  const summary = selected
    ? (selected.email ?? selected.accountId ?? selected.name)
    : providerAccounts.length > 0
      ? `${providerAccounts.length} connected accounts`
      : accountsLoaded
        ? "Not signed in"
        : "Checking connection…"
  const needsSignIn = connection
    ? connection.state.status === "signed-out"
    : Boolean(accountProvider && providerAccounts.length === 0)
  const browserOnly =
    connection?.actions?.length &&
    !connection.actions.includes("sign-in-key") &&
    connection.actions.includes("sign-in-browser")
  const working = connectionBusy?.provider === agent.id
  const detailsId = `provider-${agent.id}-accounts`
  return (
    <div role="listitem" aria-label={agent.name}>
      <div className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-hover text-muted-foreground">
            <HarnessIcon harness={agent.id} className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <span className="block text-ui font-medium">{agent.name}</span>
            <div className="mt-0.5 text-label text-muted-foreground">
              {connection ? (
                <ConnectionStatus connection={connection} />
              ) : (
                <span className="block break-words">
                  {accountProvider
                    ? summary
                    : installed === false
                      ? "Not installed"
                      : !connectionLoaded
                        ? "Checking connection…"
                        : "Uses your existing CLI login"}
                </span>
              )}
            </div>
          </div>
          {needsSignIn && browserOnly && connection ? (
            <Action
              size="xs"
              tone="solid"
              disabled={Boolean(connectionBusy)}
              onClick={() => {
                setExpanded(true)
                void providerConnections.act(connection.provider, {
                  kind: "sign-in-browser",
                })
              }}
            >
              Sign in
            </Action>
          ) : null}
          <Action
            size="xs"
            aria-label={`${expanded ? "Close" : "Manage"} ${agent.name}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? "Close"
              : needsSignIn && !browserOnly
                ? "Sign in"
                : "Manage"}
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform motion-reduce:transition-none",
                expanded && "rotate-180"
              )}
            />
          </Action>
        </div>
        <div className="mt-3 pl-11 @max-[400px]:pl-0">
          {primary ? (
            <RuntimeRow
              runtimeId={primary[0]}
              provider={agent.id}
              info={primary[1]}
            />
          ) : (
            <span className="text-label text-faint">
              {installed === null
                ? "Checking installation…"
                : installed === false
                  ? "Install the CLI to use this agent."
                  : agent.how === "Remote agent"
                    ? "Updated by the provider"
                    : "Reading version…"}
            </span>
          )}
        </div>
      </div>
      {expanded ? (
        <div
          id={detailsId}
          className="space-y-4 border-t border-hairline bg-surface px-4 py-4"
        >
          {connection || accountProvider ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-label font-medium">
                  {agent.name}
                  {accountProvider?.mode === "observed"
                    ? " credentials"
                    : " account"}
                </span>
                <Action
                  size="xs"
                  disabled={Boolean(connectionBusy)}
                  onClick={() => {
                    accounts.load(true)
                    providerConnections.load(true)
                  }}
                >
                  Refresh connection
                </Action>
              </div>
              {connection ? (
                <>
                  {working ? (
                    <p
                      role="status"
                      className="text-label text-muted-foreground"
                    >
                      {connectionBusy.action === "sign-in-browser"
                        ? "Complete sign-in in your browser. This will refresh when you’re connected."
                        : "Updating connection…"}
                    </p>
                  ) : null}
                  <ConnectionControls
                    connection={connection}
                    keyOpen={keyOpen}
                    onPasteKey={() => {
                      providerConnections.dismissFailure(connection.provider)
                      setKeyOpen(true)
                    }}
                  />
                  {keyOpen ? (
                    <ConnectionKeyForm
                      connection={connection}
                      onClose={() => setKeyOpen(false)}
                    />
                  ) : null}
                  <ConnectionNotes connection={connection} keyOpen={keyOpen} />
                </>
              ) : null}
              {accountProvider ? (
                <ProviderAccounts providerId={agent.id} />
              ) : null}
            </div>
          ) : (
            <p className="text-label text-muted-foreground">
              {installed === false
                ? `Install ${agent.name}, then refresh to connect.`
                : `${agent.name} manages sign-in in its own CLI.`}
            </p>
          )}
          {primary ? <InstallationDetails info={primary[1]} /> : null}
          {runtimes.length > 1 ? (
            <div className="space-y-3 border-t border-hairline pt-3">
              <p className="text-label font-medium">Other installations</p>
              <p className="text-label text-faint">
                New conversations use the version shown above. These copies may
                be used by older conversations.
              </p>
              {runtimes.slice(1).map(([id, info]) => (
                <div key={id} className="space-y-2">
                  <RuntimeRow runtimeId={id} provider={agent.id} info={info} />
                  <InstallationDetails info={info} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
