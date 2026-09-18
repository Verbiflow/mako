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
import { RuntimeRow } from "./harness-updates"
import { runtimeBusy, runtimeRows } from "@/lib/runtime-updates"
import { cn } from "@/lib/utils"

interface Agent {
  id: string
  name: string
  how: string
}
const columns =
  "grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.35fr)] gap-x-5 @max-[540px]:grid-cols-1 @max-[540px]:gap-y-4"

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
      <div className="mb-2 flex items-center justify-between">
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
        role="table"
        aria-label="Agents, accounts and versions"
        className="overflow-hidden rounded-lg border border-hairline"
      >
        <div
          role="row"
          className={cn(
            columns,
            "border-b border-hairline bg-surface px-3 py-2 text-label text-faint @max-[540px]:hidden"
          )}
        >
          <span role="columnheader">Agent</span>
          <span role="columnheader">Account</span>
          <span role="columnheader">Version</span>
        </div>
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
  const [expanded, setExpanded] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const selected = providerAccounts.find((account) => account.active)
  const summary = selected
    ? (selected.email ?? selected.accountId ?? selected.name)
    : providerAccounts.length > 0
      ? `${providerAccounts.length} credentials`
      : accountsLoaded
        ? "No credentials found"
        : "Checking account…"
  const canManage = Boolean(connection || accountProvider)
  const needsSignIn = connection
    ? connection.state.status === "signed-out"
    : providerAccounts.length === 0
  const accountBusy = useAccounts((state) => Boolean(state.busy))
  const connectionBusy = useProviderConnections((state) => Boolean(state.busy))
  const detailsId = `provider-${agent.id}-accounts`
  return (
    <div role="rowgroup" className="border-b border-hairline last:border-b-0">
      <div role="row" className={cn(columns, "px-3 py-3.5")}>
        <div role="cell" className="flex items-start gap-2.5">
          <HarnessIcon harness={agent.id} className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <span className="block text-ui font-medium">{agent.name}</span>
            <span className="mt-0.5 block text-label text-faint">
              {agent.how}
            </span>
          </div>
        </div>
        <div role="cell" className="min-w-0">
          <span className="mb-1 hidden text-label text-faint @max-[540px]:block">
            Account
          </span>
          {connection ? (
            <ConnectionStatus connection={connection} />
          ) : (
            <span className="block text-label break-words text-muted-foreground">
              {canManage
                ? summary
                : installed === false
                  ? "Install to connect"
                  : "Managed by provider"}
            </span>
          )}
          {canManage ? (
            <Action
              size="xs"
              className="mt-1 -ml-1.5"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Close" : needsSignIn ? "Sign in" : "Manage"}
              <ChevronDownIcon
                className={cn(
                  "size-3 transition-transform motion-reduce:transition-none",
                  expanded && "rotate-180"
                )}
              />
            </Action>
          ) : null}
        </div>
        <div role="cell" className="min-w-0 space-y-3">
          <span className="mb-1 hidden text-label text-faint @max-[540px]:block">
            Version
          </span>
          {runtimes.map(([id, info]) => (
            <RuntimeRow
              key={id}
              runtimeId={id}
              provider={agent.id}
              info={info}
            />
          ))}
          {runtimes.length === 0 ? (
            <span className="text-label text-faint">
              {installed === null
                ? "Checking installation…"
                : installed === false
                  ? "Not installed"
                  : agent.how === "Remote agent"
                    ? "Managed remotely"
                    : updates === null
                      ? "Reading version…"
                      : "Version unavailable"}
            </span>
          ) : null}
        </div>
      </div>
      {canManage && expanded ? (
        <div role="row">
          <div
            role="cell"
            aria-colspan={3}
            id={detailsId}
            className="border-t border-hairline bg-surface px-3 py-3"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-ui font-medium">
                {agent.name}{" "}
                {accountProvider?.mode === "observed"
                  ? "credentials"
                  : "accounts"}
              </span>
              <Action
                size="xs"
                disabled={accountBusy || connectionBusy}
                onClick={() => {
                  accounts.load(true)
                  providerConnections.load(true)
                }}
              >
                Refresh accounts
              </Action>
            </div>
            {connection ? (
              <div className="group/harness space-y-3">
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
              </div>
            ) : null}
            {accountProvider ? (
              <ProviderAccounts providerId={agent.id} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
