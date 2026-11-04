import { useEffect, useRef, useState } from "react"
import { EllipsisIcon, PlusIcon } from "lucide-react"
import { Action, IconAction, Toggle } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { accountIdentity } from "@/lib/account-identity"
import { accounts, useAccounts } from "@/state/accounts"
import { modelConnections, useModelConnections } from "@/state/model-connections"
import {
  MODEL_CONNECTION_PROVIDERS,
  type ModelConnectionProvider,
  type ModelConnectionView,
} from "@mako/host/contracts/model-connections"
import { AddConnection, ConnectionMark, MarkTile } from "./add-connection"
import { SignInCard } from "./provider-accounts"

const ROWS = "bg-raised"

function providerOf(id: string): ModelConnectionProvider | undefined {
  return MODEL_CONNECTION_PROVIDERS.find((provider) => provider.id === id)
}

/** An endpoint's host, as a row names it. */
function endpoint(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Connections: every way the person pays for models, in one list. A
 * subscription's row is its harness's sign-ins; a gateway's, a local
 * server's or an endpoint's says what it serves and can be tested, turned
 * off or removed.
 */
export function ModelConnections() {
  useHarnessIdentity()
  const snapshot = useModelConnections((state) => state.snapshot)
  const error = useModelConnections((state) => state.error)
  const signIn = useAccounts((state) => state.signIn)
  const signInLabel = useAccounts((state) => state.providers.find((provider) => provider.provider === state.signIn?.harness)?.label)
  const subscriptions = useSubscriptionRows()
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    void modelConnections.load()
    accounts.load()
  }, [])

  const kept = snapshot?.connections ?? []
  return (
    <section id="connections" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="text-ui font-medium">Connections</h3>
          <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
            Every way you pay for models. Subscriptions run in their own harness; a gateway, a local model or an
            endpoint is kept once and runs in every harness that takes it.
          </p>
        </div>
        <Action size="xs" tone="outline" onClick={() => setAdding(true)} className="shrink-0">
          <PlusIcon />
          Add a connection
        </Action>
      </div>
      {error ? <p role="alert" className="text-label text-negative">{error}</p> : null}
      {snapshot && !snapshot.secureStorage ? (
        <p role="alert" className="text-label text-caution">Your keychain is locked, so Mako can't keep a key. Unlock it to add a gateway.</p>
      ) : null}
      {signIn ? <SignInCard signIn={signIn} label={signInLabel ?? harnessLabel(signIn.harness)} /> : null}
      <div role="list" aria-label="Connections" className={ROWS}>
        {subscriptions.map((row) => (
          <SubscriptionRow key={row.provider.id} {...row} />
        ))}
        {kept.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} issue={snapshot?.issues.find((entry) => entry.id === connection.id)?.message} />
        ))}
        {snapshot && !kept.length && !subscriptions.length ? (
          <div role="listitem" className="px-4 py-4 text-label leading-relaxed text-faint">
            No connections yet. Sign in to a plan, paste a gateway key, or point Mako at a model running on this Mac.
          </div>
        ) : null}
      </div>
      {adding ? <AddConnection onClose={() => setAdding(false)} /> : null}
    </section>
  )
}

interface SubscriptionRowData {
  provider: ModelConnectionProvider
  who: string[]
  addable: boolean
}

/** Each subscription the person is signed in to, from the accounts every harness lists. */
function useSubscriptionRows(): SubscriptionRowData[] {
  const providers = useAccounts((state) => state.providers)
  const listed = useAccounts((state) => state.accounts)
  return MODEL_CONNECTION_PROVIDERS.filter((provider) => provider.kind === "subscription").flatMap((provider) => {
    const signedIn = listed.filter((account) =>
      account.harness === provider.harness && !account.missing && !account.signedOut &&
      (provider.openCodeProvider ? account.providerId === provider.openCodeProvider && account.authType === "oauth" : true))
    if (!signedIn.length) return []
    const info = providers.find((entry) => entry.provider === provider.harness)
    return [{
      provider,
      who: signedIn.map((account) => account.email ?? accountIdentity(account)),
      addable: info?.mode === "selectable" && info.nativeLogin === true && !provider.openCodeProvider,
    }]
  })
}

function SubscriptionRow({ provider, who, addable }: SubscriptionRowData) {
  const busy = useAccounts((state) => Boolean(state.signIn))
  const harness = harnessLabel(provider.harness ?? "")
  const people = who.length > 2 ? `${who.slice(0, 2).join(", ")} and ${who.length - 2} more` : who.join(", ")
  return (
    <div role="listitem" className="flex items-center gap-3 py-2.5 pr-2.5 pl-4">
      <MarkTile><ConnectionMark provider={provider} /></MarkTile>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium">{provider.name}</span>
        <span className="block truncate text-label text-faint" title={who.join(", ")}>
          {`Serves ${harness} · ${people}`}
        </span>
      </span>
      {addable && provider.harness ? (
        <Action size="xs" disabled={busy} onClick={() => void accounts.signIn(provider.harness!)} className="font-normal text-faint">
          Add another
        </Action>
      ) : null}
    </div>
  )
}

function serving(connection: ModelConnectionView): string {
  if (!connection.serves.length) return "Off"
  return connection.serves
    .map((serve) => `Serves ${harnessLabel(serve.harness)}: ${serve.models} ${serve.models === 1 ? "model" : "models"}`)
    .join(" · ")
}

function ConnectionRow({ connection, issue }: { connection: ModelConnectionView; issue?: string }) {
  const busy = useModelConnections((state) => state.busy)
  const test = useModelConnections((state) => state.tests[connection.id])
  const [removing, setRemoving] = useState(false)
  const confirming = useRef(false)
  const provider = providerOf(connection.provider)
  const working = busy === connection.id
  return (
    <div role="listitem" className="flex flex-col">
      <div className="flex items-center gap-3 py-2.5 pr-2.5 pl-4">
        <MarkTile><ConnectionMark provider={provider} /></MarkTile>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium">{connection.name}</span>
          <span className="block truncate text-label text-faint" title={connection.baseUrl}>
            {`${serving(connection)} · ${endpoint(connection.baseUrl)}`}
          </span>
        </span>
        <Action size="xs" disabled={Boolean(busy)} onClick={() => void modelConnections.test(connection.id)} className="font-normal text-faint">
          {working && !removing ? "Testing…" : "Test"}
        </Action>
        <Toggle
          label={connection.enabled ? `Turn off ${connection.name}` : `Turn on ${connection.name}`}
          on={connection.enabled}
          disabled={Boolean(busy)}
          onChange={() => void modelConnections.setEnabled(connection.id, !connection.enabled)}
        />
        <Menu modal={false}>
          <MenuTrigger asChild>
            <IconAction size="xs" label={`${connection.name} options`}>
              <EllipsisIcon />
            </IconAction>
          </MenuTrigger>
          <MenuContent
            align="end"
            className="min-w-44"
            onCloseAutoFocus={(event) => {
              if (!confirming.current) return
              confirming.current = false
              event.preventDefault()
            }}
          >
            <MenuItem
              className="text-negative"
              onSelect={() => {
                confirming.current = true
                setRemoving(true)
              }}
            >
              Remove connection
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {issue ? <p className="pb-2.5 pl-14 text-label text-caution">{issue}</p> : null}
      {test ? (
        <div role="status" className="flex items-center gap-2 pr-2.5 pb-2.5 pl-14 text-label">
          <span className={"error" in test ? "flex-1 text-negative" : "flex-1 text-muted-foreground"}>
            {"error" in test
              ? test.error
              : test.result.missing.length
                ? `Reachable: it lists ${test.result.listed} models. ${test.result.missing.length === 1 ? `${test.result.missing[0]} is` : `${test.result.missing.length} models you kept are`} no longer listed.`
                : `Reachable: it lists ${test.result.listed} models, every one you kept among them.`}
          </span>
          <Action size="xs" onClick={() => modelConnections.dismissTest(connection.id)}>Dismiss</Action>
        </div>
      ) : null}
      {removing ? (
        <div className="flex flex-wrap items-center gap-2 pr-2.5 pb-2.5 pl-14 text-label text-muted-foreground">
          <span className="flex-1">
            {connection.credential ? "Remove this connection and its key from this Mac?" : "Remove this connection?"}
          </span>
          <Action size="xs" autoFocus onClick={() => setRemoving(false)}>Keep</Action>
          <Action
            size="xs"
            tone="danger"
            disabled={Boolean(busy)}
            onClick={() => void modelConnections.remove(connection.id).then(() => setRemoving(false))}
          >
            Remove
          </Action>
        </div>
      ) : null}
    </div>
  )
}
