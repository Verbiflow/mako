import { useState } from "react"
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
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
import { HarnessCapabilities } from "./harness-capabilities"
import { InstallRow, RuntimeRow, InstallationDetails } from "./harness-updates"
import { Collapse } from "@/components/ui/collapse"
import { Disclosure } from "@/components/ui/notice"
import { runtimeBusy, runtimeRows } from "@/lib/runtime-updates"
import { accountIdentity } from "@/lib/account-identity"
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
      await Promise.all([
        accounts.reload(),
        providerConnections.reload(),
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
          <Spinner icon={RefreshCwIcon} turning={refreshing || busy} />
          {refreshing || busy ? "Checking…" : "Refresh"}
        </Action>
      </div>
      <div
        role="list"
        aria-label="Agent connections"
        className="overflow-hidden bg-raised"
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
  const missing = updates?.[agent.id]
  const installable =
    !primary && missing && !missing.binary && missing.checkedAt !== undefined
      ? missing
      : undefined
  const [expanded, setExpanded] = useState(false)
  // A sign-in started for this harness from anywhere (the composer's line after an install, this row) is finished
  // here, so the row opens to show it.
  const signingIn = useAccounts((state) => state.signIn?.harness === agent.id)
  const [heardSignIn, setHeardSignIn] = useState(false)
  if (signingIn !== heardSignIn) {
    setHeardSignIn(signingIn)
    if (signingIn) setExpanded(true)
  }
  const [keyOpen, setKeyOpen] = useState(false)
  const selected = providerAccounts.find((account) => account.active)
  const summary = selected
    ? selected.missing
      ? "Selected account no longer available"
      : (selected.email ?? selected.accountId ?? accountIdentity(selected))
    : providerAccounts.length > 0
      ? `${providerAccounts.length} connected accounts`
      : accountsLoaded
        ? "Not signed in"
        : "Checking connection…"
  // Not installed comes first: signing in to a harness that isn't here yet is the step after its Install.
  const notInstalled = Boolean(installable) || (installed === false && !primary)
  const needsSignIn = !notInstalled && (connection
    ? connection.state.status === "signed-out"
    : Boolean(accountProvider && providerAccounts.length === 0))
  const browserOnly =
    connection?.actions?.length &&
    !connection.actions.includes("sign-in-key") &&
    connection.actions.includes("sign-in-browser")
  const working = connectionBusy?.provider === agent.id
  // Everything the row shows is read again: the sign-in and the installation beside it.
  const [rechecking, setRechecking] = useState(false)
  const recheck = async () => {
    setRechecking(true)
    try {
      await Promise.all([accounts.reload(), providerConnections.reload(), providers.loadRuntimeUpdates(true)])
    } finally {
      setRechecking(false)
    }
  }
  const detailsId = `provider-${agent.id}-accounts`
  return (
    <div role="listitem" aria-label={agent.name}>
      <div className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center bg-fill-hover text-muted-foreground">
            <HarnessIcon harness={agent.id} className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <span className="block text-ui font-medium">{agent.name}</span>
            <div className="mt-0.5 text-label text-muted-foreground">
              {notInstalled ? (
                <span className="block break-words">Not installed</span>
              ) : connection ? (
                <ConnectionStatus connection={connection} />
              ) : (
                <span className={cn("block break-words", accountProvider && selected?.missing && "text-caution")}>
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
              : needsSignIn && !browserOnly && (connection || accountProvider?.nativeLogin)
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
          ) : installable ? (
            <InstallRow
              runtimeId={agent.id}
              name={agent.name}
              info={installable}
              onInstalled={() => setExpanded(true)}
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
        {/* The row opens beneath its own header, at the same width and indent: who it's signed in as and what
            that leaves first, then what works in Mako and the installation's details, quieter. */}
        <Collapse open={expanded}>
          <div
            id={detailsId}
            className="mt-3 ml-11 space-y-3 border-t border-hairline pt-3 @max-[400px]:ml-0"
          >
            {connection ? (
              <>
                {working ? (
                  <p role="status" className="text-label text-muted-foreground">
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
                  <ConnectionKeyForm connection={connection} onClose={() => setKeyOpen(false)} />
                ) : null}
                <ConnectionNotes connection={connection} keyOpen={keyOpen} />
              </>
            ) : null}
            {accountProvider && !notInstalled ? (
              <ProviderAccounts providerId={agent.id} hint={!connection} />
            ) : !connection && !notInstalled ? (
              <p className="text-label text-muted-foreground">
                {agent.name} uses the sign-in of its own CLI.
              </p>
            ) : null}
            {runtimes.length > 1 ? (
              // Two copies is when a path helps: it says which one new conversations run.
              <div className="space-y-2">
                <p className="text-label text-muted-foreground">
                  Also installed. New conversations use the version above; older ones may use these.
                </p>
                {runtimes.slice(1).map(([id, info]) => (
                  <div key={id} className="space-y-1">
                    <RuntimeRow runtimeId={id} provider={agent.id} info={info} />
                    {info.binary ? (
                      <p className="font-mono text-code break-all text-faint">{info.binary}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="space-y-0.5">
              <HarnessCapabilities harness={agent.id} />
              <Disclosure summary="Details" bodyClassName="pt-2 pb-1">
                <div className="space-y-2">
                  {primary ? <InstallationDetails info={primary[1]} /> : null}
                  <Action
                    size="xs"
                    className="-ml-1.5 font-normal"
                    disabled={Boolean(connectionBusy) || rechecking}
                    aria-busy={rechecking}
                    onClick={() => void recheck()}
                  >
                    {rechecking ? "Checking…" : "Check sign-in and version again"}
                  </Action>
                </div>
              </Disclosure>
            </div>
          </div>
        </Collapse>
      </div>
    </div>
  )
}
