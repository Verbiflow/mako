import { useState, type FormEvent } from "react"
import { ArrowUpRightIcon, ChevronRightIcon, CircleAlertIcon, KeyRoundIcon } from "lucide-react"
import { CLOUD_ACCESS_CATALOG, CLOUD_ACCESS_HINT, CLOUD_ACCESS_SERVICES, type CloudAccessGrant, type CloudAccessService } from "@mako/host/contracts/cloud-access"
import { Action, Eyebrow, ListCard, ListCardRow } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { copyAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import { grantAccount, lastUsedWords, useCloudAccess, usedByName, type CloudAccessBusy, type CloudAccessTransport, type CloudAccessUsesPhase } from "@/state/cloud-access"
import { expiryWords } from "@/state/github-token"

const inputClass =
  "h-8 min-w-0 flex-1 rounded-md bg-raised px-2.5 text-ui text-foreground ring-1 ring-hairline placeholder:text-faint focus:outline-none focus-visible:ring-border"

/**
 * A project's "Access" in Mako Cloud (Settings › Apps › a project, under its carried files): one row per service, each
 * connected with a token the person makes on the service's own page, which the cloud checks before it keeps it for the
 * project's cloud Threads. Connected, a row says the account it acts in, when it lapses and when a cloud Thread last
 * used it; removing it, confirmed in place, reaches running cloud Threads within a minute. The desktop's, and a
 * laptop browser's Settings too.
 */
export function CloudAccess({ transport, repository }: { transport: CloudAccessTransport; repository: string }) {
  const access = useCloudAccess(transport, repository)
  const { phase } = access
  const grants = phase.kind === "ready" ? phase.grants : []
  return (
    <section className="flex flex-col gap-2" data-cloud-access={repository}>
      <div className="flex flex-col gap-0.5">
        <Eyebrow>Access</Eyebrow>
        <p className="px-1 text-label leading-relaxed text-faint">{CLOUD_ACCESS_HINT}</p>
      </div>
      <ListCard>
        {phase.kind === "loading" ? (
          <ListCardRow className="text-ui text-faint"><Shimmer text="Reading…" /></ListCardRow>
        ) : phase.kind === "failed" ? (
          <ListCardRow className="flex items-center gap-2 text-label">
            <CircleAlertIcon className="size-3.5 shrink-0 text-caution" />
            <span className="min-w-0 flex-1 text-muted-foreground">{phase.message}</span>
            <Action size="xs" onClick={access.read}>Try again</Action>
          </ListCardRow>
        ) : (
          CLOUD_ACCESS_SERVICES.map((service) => (
            <ServiceRow
              key={service}
              service={service}
              grant={grants.find((grant) => grant.service === service)}
              busy={access.busy}
              error={access.errors[service]}
              onOpen={(url) => transport.openUrl(url)}
              onSave={(token, account) => access.save(service, token, account)}
              onRemove={() => access.remove(service)}
              onEdit={() => access.clearError(service)}
            />
          ))
        )}
        {grants.length ? <RecentUse uses={access.uses} transport={transport} onOpen={access.readUses} /> : null}
      </ListCard>
    </section>
  )
}

function ServiceRow({ service, grant, busy, error, onOpen, onSave, onRemove, onEdit }: {
  service: CloudAccessService
  grant: CloudAccessGrant | undefined
  busy: CloudAccessBusy | undefined
  error: string | undefined
  onOpen: (url: string) => void
  onSave: (token: string, account?: string) => Promise<boolean>
  onRemove: () => Promise<boolean>
  onEdit: () => void
}) {
  const info = CLOUD_ACCESS_CATALOG[service]
  const [connecting, setConnecting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const mine = busy?.service === service ? busy.doing : undefined
  const cancel = () => {
    setConnecting(false)
    onEdit()
  }
  if (connecting)
    return (
      <ListCardRow>
        <TokenForm
          service={service}
          busy={mine === "saving"}
          error={error}
          replacing={Boolean(grant)}
          onOpen={() => onOpen(info.tokenPage)}
          onCancel={cancel}
          onEdit={onEdit}
          onSave={(token, account) => void onSave(token, account).then((saved) => saved && setConnecting(false))}
        />
      </ListCardRow>
    )
  if (!grant)
    return (
      <ListCardRow>
        <div className="flex items-center gap-3" data-cloud-access-service={service}>
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium text-foreground">{info.name}</p>
            <p className="mt-0.5 text-label text-muted-foreground">{info.gives}</p>
          </div>
          <Action tone="outline" size="xs" disabled={busy !== undefined} data-cloud-access-action="connect" onClick={() => setConnecting(true)}>Connect</Action>
        </div>
        {error ? <p className="mt-2 text-label text-negative">{error}</p> : null}
      </ListCardRow>
    )
  const expiry = expiryWords(grant.expiresAt)
  return (
    <ListCardRow>
      <div className="flex items-start gap-3" data-cloud-access-service={service}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui">
            <span className="font-medium text-foreground">{info.name}</span>
            <span className="text-muted-foreground"> · {grantAccount(grant)}</span>
          </p>
          <p className={cn("mt-0.5 text-label", expiry.lapsed ? "text-negative" : "text-faint")}>{expiry.lapsed ? `${expiry.text}. Replace it to use ${info.name} again.` : expiry.text}</p>
          <p className="text-label text-faint">{lastUsedWords(grant)}</p>
          <p className="mt-0.5 truncate font-mono text-label text-faint" title={grant.variables.join(", ")}>{grant.variables.join(" ")}</p>
        </div>
        {removing ? null : (
          <span className="flex shrink-0 items-center gap-1">
            <Action size="xs" tone={expiry.lapsed ? "outline" : "quiet"} disabled={busy !== undefined} onClick={() => setConnecting(true)}>Replace token</Action>
            <Action size="xs" className="text-muted-foreground" disabled={busy !== undefined} data-cloud-access-action="remove" onClick={() => setRemoving(true)}>Remove</Action>
          </span>
        )}
      </div>
      {removing ? (
        <div className="mt-2.5 flex items-center gap-3">
          <p className="min-w-0 flex-1 text-label leading-relaxed text-muted-foreground">
            Remove {info.name} from this project? Running cloud Threads lose it within a minute, and no new shell gets it.
          </p>
          <Action size="xs" disabled={mine === "removing"} onClick={() => setRemoving(false)}>Cancel</Action>
          <Action size="xs" tone="danger" disabled={busy !== undefined} onClick={() => void onRemove().then((removed) => removed && setRemoving(false))}>
            {mine === "removing" ? "Removing…" : "Remove"}
          </Action>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-label text-negative">{error}</p> : null}
    </ListCardRow>
  )
}

function TokenForm({ service, busy, error, replacing, onOpen, onCancel, onEdit, onSave }: {
  service: CloudAccessService
  busy: boolean
  error: string | undefined
  replacing: boolean
  onOpen: () => void
  onCancel: () => void
  onEdit: () => void
  onSave: (token: string, account?: string) => void
}) {
  const info = CLOUD_ACCESS_CATALOG[service]
  const [token, setToken] = useState("")
  const [account, setAccount] = useState("")
  const looksRight = token.trim().length >= info.minLength
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (looksRight && !busy) onSave(token, account)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 py-1" data-cloud-access-form={service}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-ui font-medium">1. Make a token on {info.name}</p>
          <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">{info.choose}</p>
        </div>
        <Action size="xs" tone="outline" onClick={onOpen}>
          {info.name} tokens
          <ArrowUpRightIcon />
        </Action>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-ui font-medium">2. Paste it here</span>
        <span className="flex items-center gap-2">
          <KeyRoundIcon className="size-3.5 shrink-0 text-faint" />
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={500}
            value={token}
            disabled={busy}
            placeholder={`${info.name} token`}
            aria-label={`${info.name} token`}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setToken(event.target.value)
              onEdit()
            }}
            className={cn(inputClass, "font-mono placeholder:font-sans", error && "ring-negative/60")}
          />
        </span>
        <span className="flex items-center gap-2 pl-5.5">
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            value={account}
            disabled={busy}
            placeholder={info.account.placeholder}
            aria-label={info.account.label}
            onChange={(event) => {
              setAccount(event.target.value)
              onEdit()
            }}
            className={inputClass}
          />
          <Action size="sm" disabled={busy} onClick={onCancel}>Cancel</Action>
          <Action size="sm" tone="solid" type="submit" disabled={!looksRight || busy}>
            {busy ? `Checking with ${info.name}…` : replacing ? "Replace" : "Save"}
          </Action>
        </span>
        <span className="pl-5.5 text-label text-faint">{info.account.hint}</span>
      </div>
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-label text-negative">
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <p className="text-label leading-relaxed text-faint">
        Mako Cloud checks it with {info.name}, keeps it sealed, and gives it only to this project&apos;s cloud Threads, as {[...info.variables.always, ...info.variables.whenAccount].join(", ")} in each shell. It isn&apos;t kept on this device.
      </p>
    </form>
  )
}

/** "Recent use": the latest hand-overs to cloud Threads, read when the person opens it. */
function RecentUse({ uses, transport, onOpen }: { uses: CloudAccessUsesPhase; transport: CloudAccessTransport; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <ListCardRow className="py-2">
      <button
        type="button"
        aria-expanded={open}
        className="pressable flex w-full items-center gap-1.5 text-left text-label font-medium text-muted-foreground hover:text-foreground"
        onClick={() => {
          if (!open && uses.kind !== "loading") onOpen()
          setOpen(!open)
        }}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform duration-150 ease-(--ease-out)", open && "rotate-90")} />
        Recent use
      </button>
      {open ? (
        <div className="mt-2 pl-5">
          {uses.kind === "loading" || uses.kind === "unread" ? (
            <p className="text-label text-faint"><Shimmer text="Reading…" /></p>
          ) : uses.kind === "failed" ? (
            <p className="text-label text-caution">{uses.message}</p>
          ) : uses.uses.length ? (
            <ul className="flex flex-col gap-1">
              {uses.uses.map((use) => (
                <li key={`${use.service}-${use.threadId}-${use.at}`} className="flex items-baseline gap-3 text-label">
                  <span className="w-20 shrink-0 text-muted-foreground">{CLOUD_ACCESS_CATALOG[use.service].name}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{usedByName(transport, use)}</span>
                  <span className="shrink-0 text-faint tabular-nums">{copyAge(Date.parse(use.at))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-label text-faint">No cloud Thread has used these yet.</p>
          )}
        </div>
      ) : null}
    </ListCardRow>
  )
}
