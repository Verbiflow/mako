import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon, KeyRoundIcon, LaptopMinimalIcon, SearchIcon, ServerIcon, XIcon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { FIELD, Action, Check, Eyebrow, IconAction } from "@/components/ui/kit"
import { HarnessIcon, ProviderIcon } from "@/components/ui/provider-icon"
import { Spinner } from "@/components/ui/spinner"
import { useCopy } from "@/components/ui/use-copy"
import { formatTokens } from "@/lib/format"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { accounts, useAccounts } from "@/state/accounts"
import { desktop } from "@/state/desktop"
import { modelConnections, useModelConnections } from "@/state/model-connections"
import {
  MODEL_CONNECTION_PROVIDERS,
  type ConnectionModel,
  type ModelConnectionCheck,
  type ModelConnectionKind,
  type ModelConnectionProvider,
} from "@mako/host/contracts/model-connections"
import { routeAccepted } from "@mako/host/contracts/model-routes"

const inputClass = cn(FIELD, "h-9 w-full")

const GROUPS: Array<{ kind: ModelConnectionKind; title: string; note: string }> = [
  { kind: "subscription", title: "Subscriptions", note: "Sign in with the plan you already pay for." },
  { kind: "gateway", title: "Gateways", note: "Paste a key; its models appear under every harness that takes them." },
  { kind: "local", title: "Local", note: "Models running on this Mac, which your agents reach on localhost." },
  { kind: "custom", title: "Custom endpoint", note: "A base URL and a key." },
]

/** A provider's mark: its brand where Mako has one, the harness's for a subscription, else what it is. */
export function ConnectionMark({ provider, className = "size-3.5" }: { provider: ModelConnectionProvider | undefined; className?: string }) {
  if (provider?.openCodeProvider) return <ProviderIcon provider={provider.openCodeProvider === "github-copilot" ? "github" : provider.openCodeProvider} tinted={false} className={className} />
  if (provider?.harness) return <HarnessIcon harness={provider.harness} tinted={false} className={className} />
  if (provider?.kind === "local" && provider.id === "local") return <LaptopMinimalIcon className={cn(className, "text-faint")} />
  if (provider?.kind === "custom") return <ServerIcon className={cn(className, "text-faint")} />
  return <ProviderIcon provider={provider?.id ?? "?"} tinted={false} className={className} />
}

export function MarkTile({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center bg-fill-hover">
      {children}
    </span>
  )
}

/** What a subscription row says of the person's sign-ins, and whether the harness signs in another here. */
function useSubscription(provider: ModelConnectionProvider) {
  const info = useAccounts((state) => state.providers.find((entry) => entry.provider === provider.harness))
  const signedIn = useAccounts((state) => state.accounts.filter((account) =>
    account.harness === provider.harness && !account.missing && !account.signedOut &&
    (provider.openCodeProvider ? account.providerId === provider.openCodeProvider && account.authType === "oauth" : true)
  ).length)
  const addable = info?.mode === "selectable" && info.nativeLogin === true && !provider.openCodeProvider
  return { info, signedIn, addable }
}

/**
 * Add a connection: every way to pay for models in one searchable list.
 * Subscriptions open their harness's own sign-in; a gateway, a local server
 * or an endpoint is checked for its models, then kept once and routed to
 * every harness whose adapter takes it.
 */
export function AddConnection({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<ModelConnectionProvider | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    accounts.load()
    void modelConnections.detectLocal()
  }, [])

  const term = query.trim().toLowerCase()
  const shown = MODEL_CONNECTION_PROVIDERS.filter((provider) =>
    !term || `${provider.name} ${provider.description} ${provider.kind}`.toLowerCase().includes(term))

  const pick = (provider: ModelConnectionProvider, addable: boolean) => {
    if (provider.kind === "subscription" && addable && provider.harness) {
      onClose()
      void accounts.signIn(provider.harness)
      return
    }
    setPicked(provider)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent
        className="flex max-h-[min(40rem,88vh)] max-w-lg flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          search.current?.focus()
        }}
      >
        {picked ? (
          picked.kind === "subscription" ? (
            <SubscriptionDetail provider={picked} onBack={() => setPicked(null)} onClose={onClose} />
          ) : (
            <ConnectionForm provider={picked} onBusy={setBusy} onBack={() => setPicked(null)} onClose={onClose} />
          )
        ) : (
          <>
            <header className="flex items-center gap-3 px-5 pt-5 pb-3">
              <DialogTitle className="flex-1">Add a connection</DialogTitle>
              <IconAction label="Close" onClick={onClose}>
                <XIcon />
              </IconAction>
            </header>
            <div className="px-5 pb-3">
              <label className="flex h-8 items-center gap-2 bg-surface px-2.5 focus-within:ring-border">
                <SearchIcon className="size-3.5 shrink-0 text-faint" />
                <input
                  ref={search}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search providers, gateways and servers"
                  aria-label="Search connections"
                  className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              {GROUPS.map((group) => {
                const rows = shown.filter((provider) => provider.kind === group.kind)
                if (!rows.length) return null
                return (
                  <section key={group.kind} aria-label={group.title} className="pt-2 pb-1">
                    <Eyebrow className="px-2 pb-0.5">{group.title}</Eyebrow>
                    <p className="px-2 pb-1.5 text-label text-faint">{group.note}</p>
                    {rows.map((provider) => (
                      <ProviderRow key={provider.id} provider={provider} onPick={pick} />
                    ))}
                  </section>
                )
              })}
              {!shown.length ? (
                <p className="px-2 py-8 text-center text-ui text-faint">
                  Nothing matches. A custom endpoint takes any OpenAI-compatible URL.
                </p>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ProviderRow({ provider, onPick }: { provider: ModelConnectionProvider; onPick: (provider: ModelConnectionProvider, addable: boolean) => void }) {
  useHarnessIdentity()
  const subscription = useSubscription(provider)
  const connected = useModelConnections((state) => provider.kind === "gateway" && state.snapshot?.connections.some((connection) => connection.provider === provider.id))
  const local = useModelConnections((state) => state.local?.find((server) => server.provider === provider.id))
  const detecting = useModelConnections((state) => provider.kind === "local" && provider.key === "none" && state.local === undefined)

  const status = provider.kind === "subscription"
    ? subscription.signedIn
      ? subscription.signedIn === 1 ? "Signed in" : `${subscription.signedIn} accounts`
      : undefined
    : connected
      ? "Connected"
      : local
        ? local.running ? `Running · ${local.models.length} ${local.models.length === 1 ? "model" : "models"}` : "Not running"
        : undefined
  const action = provider.kind === "subscription"
    ? subscription.addable ? (subscription.signedIn ? "Add another" : "Sign in") : undefined
    : undefined

  return (
    <button
      type="button"
      disabled={connected}
      onClick={() => onPick(provider, subscription.addable)}
      className="pressable group/row flex w-full items-center gap-3 px-2 py-2 text-left outline-none hover:bg-fill-hover focus-visible:bg-fill-hover disabled:pointer-events-none disabled:opacity-60"
    >
      <MarkTile><ConnectionMark provider={provider} /></MarkTile>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium">{provider.name}</span>
        <span className="block truncate text-label text-faint">{provider.description}</span>
      </span>
      {detecting ? <Spinner className="size-3.5 text-faint" aria-label="Looking for the server" /> : null}
      {status ? (
        <span className={cn("flex shrink-0 items-center gap-1 text-label", local?.running || subscription.signedIn || connected ? "text-muted-foreground" : "text-faint")}>
          {subscription.signedIn || connected ? <CheckIcon className="size-3.5" /> : null}
          {status}
        </span>
      ) : null}
      {action ? <span className="shrink-0 text-label text-muted-foreground group-hover/row:text-foreground">{action}</span> : <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />}
    </button>
  )
}

function PaneHeader({ provider, title, onBack, onClose, disabled }: { provider: ModelConnectionProvider; title: string; onBack: () => void; onClose: () => void; disabled?: boolean }) {
  return (
    <header className="flex items-center gap-2 px-4 pt-4 pb-3">
      <IconAction label="Back to all connections" disabled={disabled} onClick={onBack}>
        <ArrowLeftIcon />
      </IconAction>
      <MarkTile><ConnectionMark provider={provider} /></MarkTile>
      <DialogTitle className="flex-1 truncate">{title}</DialogTitle>
      <IconAction label="Close" disabled={disabled} onClick={onClose}>
        <XIcon />
      </IconAction>
    </header>
  )
}

/** A subscription its harness signs in to outside Mako: the command, and that Mako picks it up. */
function SubscriptionDetail({ provider, onBack, onClose }: { provider: ModelConnectionProvider; onBack: () => void; onClose: () => void }) {
  useHarnessIdentity()
  const { info, signedIn } = useSubscription(provider)
  const command = info?.loginCommand
  const { copied, copy } = useCopy(command ?? "")
  const harness = harnessLabel(provider.harness ?? "")
  return (
    <>
      <PaneHeader provider={provider} title={provider.name} onBack={onBack} onClose={onClose} />
      <div className="flex flex-col gap-4 px-5 pb-5">
        <p className="text-ui leading-relaxed text-muted-foreground">
          {provider.openCodeProvider
            ? `${provider.name} signs in through ${harness}'s own login. Run this in a terminal and choose ${provider.name}; its models then appear in ${harness}'s model list.`
            : `${harness} keeps this login itself. Run this in a terminal to sign in; Mako picks the account up.`}
        </p>
        {command ? (
          <div className="flex items-center gap-2 bg-raised px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-code text-foreground">{command}</code>
            <Action size="xs" onClick={() => void copy()}>
              {copied ? <CheckIcon /> : <CopyIcon className="text-faint" />}
              {copied ? "Copied" : "Copy"}
            </Action>
          </div>
        ) : null}
        {signedIn ? (
          <p className="flex items-center gap-1.5 text-label text-muted-foreground">
            <CheckIcon className="size-3.5" />
            {`${harness} is signed in to ${provider.name}.`}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Action onClick={() => accounts.load(true)}>Check again</Action>
          <Action tone="solid" onClick={onClose}>Done</Action>
        </div>
      </div>
    </>
  )
}

/** A key's host, as "Create a key at …" names it. */
function keyHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

/**
 * A gateway, local server or endpoint: its URL and key, Check access listing
 * what it serves, and which of those models to keep.
 */
function ConnectionForm({ provider, onBusy, onBack, onClose }: { provider: ModelConnectionProvider; onBusy: (busy: boolean) => void; onBack: () => void; onClose: () => void }) {
  const key = useRef<HTMLInputElement>(null)
  const [hasKey, setHasKey] = useState(false)
  const editableUrl = Boolean(provider.urlHint) || provider.kind === "custom"
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "")
  const [name, setName] = useState("")
  const [checking, setChecking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<ModelConnectionCheck | null>(null)
  const [kept, setKept] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState("")
  const version = useRef(0)
  const working = checking || adding
  useEffect(() => {
    onBusy(working)
  }, [onBusy, working])
  const needsKey = provider.key === "required"
  const host = provider.keyUrl ? keyHost(provider.keyUrl) : null
  useHarnessIdentity()
  const declared = useModelConnections((state) => state.snapshot?.harnesses)
  const takenBy = (declared ?? []).filter(({ routes }) => routeAccepted(routes, provider.kind, provider.wire ?? "openai-chat")).map(({ harness }) => harnessLabel(harness))

  const invalidate = () => {
    version.current += 1
    setChecking(false)
    setCheck(null)
    setError(null)
  }

  const runCheck = async () => {
    const current = ++version.current
    setChecking(true)
    setError(null)
    try {
      const result = await modelConnections.check({ provider: provider.id, baseUrl: baseUrl || undefined, apiKey: key.current?.value || undefined })
      if (current !== version.current) return
      setCheck(result)
      setKept(new Set(result.models.map((model) => model.id)))
    } catch (caught) {
      if (current === version.current) setError(caught instanceof Error ? caught.message : "Couldn't check access. Try again.")
    } finally {
      if (current === version.current) setChecking(false)
    }
  }

  // A server Mako found on its usual port is checked as the form opens: there's nothing to enter first.
  const local = useModelConnections((state) => state.local?.find((server) => server.provider === provider.id))
  const autoChecked = useRef(false)
  useEffect(() => {
    if (autoChecked.current || !local?.running) return
    autoChecked.current = true
    queueMicrotask(() => void runCheck())
  })

  const add = async () => {
    if (!check) return
    setAdding(true)
    setError(null)
    try {
      await modelConnections.add({
        provider: provider.id,
        baseUrl: baseUrl || undefined,
        apiKey: key.current?.value || undefined,
        name: name.trim() || undefined,
        models: check.models.filter((model) => kept.has(model.id)),
      })
      if (key.current) key.current.value = ""
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The connection wasn't added. Try again.")
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <PaneHeader provider={provider} title={`Connect ${provider.name}`} onBack={onBack} onClose={onClose} disabled={working} />
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          void (check ? add() : runCheck())
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
          <p className="text-label leading-relaxed text-faint">{provider.description}.</p>
          <fieldset disabled={adding} className="flex min-w-0 flex-col gap-4 disabled:opacity-60">
            {provider.kind === "custom" ? (
              <label className="flex flex-col gap-2 text-ui font-medium">
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="My endpoint" autoComplete="off" spellCheck={false} className={inputClass} />
              </label>
            ) : null}
            {editableUrl ? (
              <label className="flex flex-col gap-2 text-ui font-medium">
                Base URL
                <input
                  type="url"
                  required
                  value={baseUrl}
                  autoFocus={!needsKey}
                  onChange={(event) => {
                    invalidate()
                    setBaseUrl(event.target.value)
                  }}
                  placeholder={provider.urlHint ?? provider.baseUrl}
                  spellCheck={false}
                  autoComplete="off"
                  className={inputClass}
                />
              </label>
            ) : (
              <p className="text-label text-faint">
                <span className="text-muted-foreground">Endpoint</span> <span className="font-mono text-code">{provider.baseUrl}</span>
              </p>
            )}
            {provider.key !== "none" ? (
              <label className="flex flex-col gap-2 text-ui font-medium">
                <span className="flex items-center gap-2">
                  <KeyRoundIcon className="size-3.5 text-faint" />
                  API key{needsKey ? "" : " (if the server asks for one)"}
                </span>
                <input
                  ref={key}
                  type="password"
                  autoFocus={needsKey}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={16_384}
                  placeholder={`Paste your ${provider.name} key`}
                  aria-describedby="connection-key-note"
                  onChange={(event) => {
                    invalidate()
                    setHasKey(Boolean(event.target.value.trim()))
                  }}
                  className={inputClass}
                />
                <span id="connection-key-note" className="flex flex-col items-start gap-0.5 text-label leading-relaxed font-normal text-faint">
                  {provider.keyUrl && host ? (
                    <button type="button" onClick={() => void desktop.openUrl(provider.keyUrl ?? "")} className="pressable inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                      Create a key at {host}
                      <ExternalLinkIcon className="size-3" />
                    </button>
                  ) : null}
                  <span>Encrypted on this Mac with the system key store, and sent only to this endpoint.</span>
                </span>
              </label>
            ) : null}
          </fieldset>
          {check ? <ModelChecklist check={check} kept={kept} filter={filter} onFilter={setFilter} onKept={setKept} disabled={adding} /> : null}
          {error ? <p role="alert" className="text-ui leading-relaxed text-negative">{error}</p> : null}
        </div>
        <footer className="flex flex-col gap-3 px-5 py-4">
          <p className="text-label leading-relaxed text-faint">
            {check
              ? takenBy.length
                ? `The models you keep appear in ${takenBy.join(" and ")}'s model list, in new conversations.`
                : "No harness takes this connection yet; it waits for one that does."
              : "Check access lists the models it serves. Nothing is saved and no prompt is sent."}
          </p>
          <div className="flex justify-end gap-2">
            {check ? (
              <Action disabled={working} onClick={() => void runCheck()}>Check again</Action>
            ) : (
              <Action onClick={onBack} disabled={working}>Cancel</Action>
            )}
            <Action
              type="submit"
              tone="solid"
              disabled={working || (check ? kept.size === 0 : (needsKey && !hasKey) || (editableUrl && !baseUrl.trim()))}
            >
              {working ? <Spinner /> : null}
              {checking ? "Checking access…" : adding ? "Adding…" : check ? `Add ${kept.size === 1 ? "1 model" : `${kept.size} models`}` : "Check access"}
            </Action>
          </div>
        </footer>
      </form>
    </>
  )
}

function ModelChecklist({ check, kept, filter, onFilter, onKept, disabled }: {
  check: ModelConnectionCheck
  kept: Set<string>
  filter: string
  onFilter: (value: string) => void
  onKept: (next: Set<string>) => void
  disabled: boolean
}) {
  const term = filter.trim().toLowerCase()
  const shown = useMemo(
    () => check.models.filter((model) => !term || `${model.id} ${model.name ?? ""}`.toLowerCase().includes(term)),
    [check.models, term]
  )
  const toggle = (model: ConnectionModel) => {
    const next = new Set(kept)
    if (next.has(model.id)) next.delete(model.id)
    else next.add(model.id)
    onKept(next)
  }
  const all = shown.every((model) => kept.has(model.id))
  return (
    <section aria-label="Models" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span role="status" className="text-ui font-medium">
          {check.models.length ? `Keeps ${kept.size} of ${check.models.length} models` : "No models"}
        </span>
        {shown.length ? (
          <Action
            size="xs"
            disabled={disabled}
            onClick={() => {
              const next = new Set(kept)
              for (const model of shown) if (all) next.delete(model.id)
              else next.add(model.id)
              onKept(next)
            }}
          >
            {all ? "Keep none" : "Keep all"}{term ? " shown" : ""}
          </Action>
        ) : null}
      </div>
      {check.notice ? <p className="text-label text-caution">{check.notice}</p> : null}
      {check.models.length > 8 ? (
        <label className="flex h-7 items-center gap-2 bg-surface px-2 focus-within:ring-border">
          <SearchIcon className="size-3.5 shrink-0 text-faint" />
          <input
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            placeholder="Filter models"
            aria-label="Filter models"
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
          />
        </label>
      ) : null}
      {check.models.length ? (
        <ul className="max-h-56 overflow-y-auto bg-raised py-1">
          {shown.map((model) => (
            <li key={model.id}>
              <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-fill-hover">
                <Check label={model.name ?? model.id} checked={kept.has(model.id)} disabled={disabled} onChange={() => toggle(model)} />
                <span className="min-w-0 flex-1 truncate text-ui">{model.name ?? model.id}</span>
                <span className="shrink-0 truncate text-label text-faint">
                  {[model.name ? model.id : undefined, model.contextTokens ? formatTokens(model.contextTokens) : undefined].filter(Boolean).join(" · ")}
                </span>
              </label>
            </li>
          ))}
          {!shown.length ? <li className="px-3 py-3 text-center text-label text-faint">No model matches.</li> : null}
        </ul>
      ) : null}
    </section>
  )
}
