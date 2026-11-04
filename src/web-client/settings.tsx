import { useEffect, useMemo, useState, type FormEvent } from "react"
import { continueReadings, describeContinue } from "@mako/host/contracts/cloud-continues"
import { describeFollow, describeList } from "@mako/host/contracts/sync-readings"
import { webContinues } from "./continue-actions"
import { readingWords, useReadings } from "./probe"
import { webSync } from "./sync-readings"
import { ArrowUpRightIcon, BellIcon, BellOffIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, GitPullRequestIcon, LogOutIcon, MoonIcon, ShareIcon, SmartphoneIcon } from "lucide-react"
import { CLOUD_ACCESS_CATALOG, CLOUD_ACCESS_HINT, CLOUD_ACCESS_SERVICES, type CloudAccessGrant, type CloudAccessService } from "@mako/host/contracts/cloud-access"
import { CloudAccess } from "@/components/settings/cloud-access"
import { grantAccount, lastUsedWords, useCloudAccess, usedByName, type CloudAccessBusy, type CloudAccessTransport, type CloudAccessUsesPhase } from "@/state/cloud-access"
import { listedRepositories, webCloudAccess } from "./cloud-access"
import { MAKO_GITHUB_APP, NEW_PERSON_TOKEN_URL, PERSON_TOKEN, PERSON_TOKEN_PERMISSIONS } from "@mako/host/contracts/github-person"
import { PullRequestsAsMe } from "@/components/settings/pull-requests-as-me"
import { expiryWords, useGitHubToken, type GitHubTokens } from "@/state/github-token"
import { webGitHubTokens } from "./github-tokens"
import { useForm } from "./route"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { copyAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import type { PushStanding, QuietHours } from "./push"
import { install, onIos, useInstallWay } from "./install"
import { IosInstallSheet } from "./install-card"
import { useTheme, type WebTheme } from "./theme"
import { setPref, usePrefs } from "@/state/prefs"
import { Group, Row, Switch } from "./settings-rows"
import { Fins } from "./fins"

const DEFAULT_QUIET: QuietHours = { start: "22:00", end: "07:00" }
/** The device's latest readings Diagnostics lists; Copy takes every one kept. */
const READINGS_SHOWN = 8

/** Settings: a screen of its own on a phone, Back to the list; wide, the pane beside the rail, opened from its foot. */
export function Settings({ onBack }: { onBack: (() => void) | undefined }) {
  const client = useWebClient()
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-shell">
      <header className={cn("web-bar flex shrink-0 items-center gap-1", onBack ? "px-1.5" : "px-5")}>
        {onBack ? (
          <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
            <ChevronLeftIcon className="size-6" strokeWidth={2} />
          </button>
        ) : null}
        <h1 className="flex-1 text-ui font-semibold">Settings</h1>
      </header>
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <div className="mx-auto flex max-w-[560px] flex-col gap-7 pt-3">
          <Group>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Avatar name={client.account.name} src={client.account.image ?? undefined} size={8} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-medium">{client.account.name}</p>
                <p className="truncate text-label text-faint">{client.account.email}</p>
              </div>
            </div>
          </Group>
          <Notifications />
          <Conversation />
          <Fins />
          <PullRequests />
          <CloudAccessSettings />
          <Appearance />
          <ThisBrowser />
          <Diagnostics />
        </div>
      </div>
    </div>
  )
}

/**
 * What Send does while an agent works: steer it, or queue the message for after the turn. The desk's own choice
 * (Settings › Conversation, "Enter steers a running turn"), the same preference, read by this browser's composers.
 */
function Conversation() {
  const steer = usePrefs((prefs) => prefs.steerOnEnter)
  return (
    <Group title="Conversation" footer={steer ? "Hold Send to queue a message for after the turn instead. Agents that can't take a message mid-turn always queue." : "Hold Send to steer the running turn instead, where its agent can take a message mid-turn."}>
      <Row
        label="Send steers a working agent"
        detail={steer ? "Your message goes into the turn it's running" : "Your message waits for the turn to end"}
        end={<Switch on={steer} label="Send steers a working agent" onChange={(on) => setPref("steerOnEnter", on)} />}
      />
    </Group>
  )
}

/**
 * "Open pull requests as me". In a laptop's browser it's the desktop's own Settings row (`PullRequestsAsMe`); on a
 * phone or tablet, the same setting in the touch layout here. Both read and change the account's, never keep the token.
 */
function PullRequests() {
  const client = useWebClient()
  const tokens = useMemo(() => webGitHubTokens(client.gateway, client.account.id), [client])
  if (useForm() === "desk") return <PullRequestsAsMe tokens={tokens} />
  return <TouchPullRequests tokens={tokens} />
}

export function TouchPullRequests({ tokens }: { tokens: GitHubTokens }) {
  const { phase, busy, error, save, remove, read, clearError } = useGitHubToken(tokens)
  const [asking, setAsking] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)
  const [token, setToken] = useState("")
  const listing = phase.kind === "ready" ? phase.listing : null
  const expiry = listing ? expiryWords(listing.expiresAt) : undefined
  const cancel = () => {
    setAsking(false)
    setToken("")
    clearError()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!PERSON_TOKEN.test(token.trim()) || busy) return
    void save(token).then((saved) => {
      if (!saved) return
      setAsking(false)
      setToken("")
    })
  }
  const footer = phase.kind === "failed"
    ? phase.message
    : listing
      ? "Your cloud Threads push, open and merge with your GitHub token. Turning this off deletes it from Mako Cloud."
      : `Off: cloud Threads open pull requests as ${MAKO_GITHUB_APP}. Pull requests from your Mac always use your own GitHub sign-in.`
  return (
    <Group title="Pull requests" footer={asking ? undefined : footer}>
      <Row
        label="Open pull requests as me"
        detail={listing ? "GitHub shows you as the author" : "From cloud Threads"}
        icon={<GitPullRequestIcon className="size-4" />}
        end={
          <Switch
            on={Boolean(listing) || asking}
            label="Open pull requests as me"
            disabled={phase.kind !== "ready" || busy !== undefined}
            onChange={(next) => {
              if (listing) setConfirmingOff(!next)
              else if (next) setAsking(true)
              else cancel()
            }}
          />
        }
      />
      {phase.kind === "failed" ? (
        <button type="button" onClick={read} className="web-row flex h-12 w-full items-center px-4 text-left text-ui">Try again</button>
      ) : null}
      {listing && expiry && !asking ? (
        <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui">Signed in as <span className="font-medium">@{listing.login}</span></p>
            <p className={cn("text-label", expiry.lapsed ? "text-negative" : "text-faint")}>{expiry.lapsed ? `${expiry.text}. Replace it to open pull requests.` : expiry.text}</p>
          </div>
          <button type="button" className="web-quiet-button h-9 px-3" disabled={busy !== undefined} onClick={() => setAsking(true)}>Replace</button>
        </div>
      ) : null}
      {confirmingOff && listing ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="text-ui">Delete your token from Mako Cloud?</p>
          <p className="text-label text-faint">Cloud Threads go back to {MAKO_GITHUB_APP}. Turning this on again needs a token.</p>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="web-quiet-button h-9 px-3" onClick={() => setConfirmingOff(false)}>Cancel</button>
            <button type="button" className="web-button web-button-negative h-9 px-3" disabled={busy !== undefined} onClick={() => void remove().then((removed) => removed && setConfirmingOff(false))}>
              {busy === "removing" ? "Turning off…" : "Turn off"}
            </button>
          </div>
        </div>
      ) : null}
      {asking ? (
        <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3.5">
          <p className="text-ui font-medium">Make a fine-grained token on GitHub</p>
          <p className="text-label text-faint">Pick the repositories cloud Threads should push to, with these repository permissions:</p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 text-label">
            {PERSON_TOKEN_PERMISSIONS.map((permission) => (
              <div key={permission.name} className="contents">
                <dt>{permission.name}</dt>
                <dd className="text-faint">{permission.access}</dd>
              </div>
            ))}
          </dl>
          <button type="button" className="web-quiet-button flex h-10 items-center justify-center gap-1.5" onClick={() => tokens.openUrl(NEW_PERSON_TOKEN_URL)}>
            New token on GitHub
            <ArrowUpRightIcon className="size-4" />
          </button>
          <input
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={300}
            value={token}
            disabled={busy === "saving"}
            placeholder="Paste it: github_pat_…"
            aria-label="GitHub token"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setToken(event.target.value)
              clearError()
            }}
            className="web-field h-11 w-full font-mono placeholder:font-sans"
          />
          {error ? <p role="alert" className="text-label text-negative">{error}</p> : null}
          <p className="text-label text-faint">Mako Cloud checks it with GitHub, keeps it encrypted, and gives it only to your cloud Threads' machines, where agents can use it. It isn't kept on this phone.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="web-quiet-button h-10 px-4" disabled={busy === "saving"} onClick={cancel}>Cancel</button>
            <button type="submit" className="web-button h-10 px-4" disabled={!PERSON_TOKEN.test(token.trim()) || busy === "saving"}>
              {busy === "saving" ? "Checking with GitHub…" : listing ? "Replace" : "Save"}
            </button>
          </div>
        </form>
      ) : null}
      {!asking && error ? <p className="px-4 py-3 text-label text-negative">{error}</p> : null}
    </Group>
  )
}

/**
 * Each project's cloud access: the accounts its cloud Threads can use. In a laptop's browser it's the desktop's own
 * part (`CloudAccess`); on a phone or tablet, the same part in the touch layout here. The projects are the account's
 * repositories its listed Sessions work in, the one prompted in latest first. Neither keeps a token.
 */
function CloudAccessSettings() {
  const client = useWebClient()
  const transport = useMemo(() => webCloudAccess(client.gateway, client.account.id), [client])
  const rows = useAccountList((state) => state.rows)
  const repositories = useMemo(() => listedRepositories(rows), [rows])
  return <CloudAccessProjects transport={transport} repositories={repositories} touch={useForm() !== "desk"} />
}

const repositoryName = (url: string) => url.replace(/^https:\/\/github\.com\//, "")

export function CloudAccessProjects({ transport, repositories, touch }: { transport: CloudAccessTransport; repositories: string[]; touch: boolean }) {
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const repository = chosen && repositories.includes(chosen) ? chosen : repositories[0]
  if (!repository) return null
  const picker = repositories.length > 1 ? (
    <select aria-label="Project" value={repository} onChange={(event) => setChosen(event.target.value)} className={touch ? "web-field w-auto max-w-[60%] truncate" : "h-8 max-w-[50%] truncate rounded-md bg-raised px-2 text-ui text-foreground ring-1 ring-hairline focus:outline-none focus-visible:ring-border"}>
      {repositories.map((url) => <option key={url} value={url}>{repositoryName(url)}</option>)}
    </select>
  ) : (
    <span className="truncate text-ui text-muted-foreground">{repositoryName(repository)}</span>
  )
  if (touch) return <TouchCloudAccess key={repository} transport={transport} repository={repository} picker={picker} />
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-ui font-medium">In Mako Cloud</h3>
          <p className="mt-0.5 text-label text-muted-foreground">For a project's Threads in the cloud.</p>
        </div>
        {picker}
      </div>
      <CloudAccess key={repository} transport={transport} repository={repository} />
    </section>
  )
}

function TouchCloudAccess({ transport, repository, picker }: { transport: CloudAccessTransport; repository: string; picker: ReactNode }) {
  const access = useCloudAccess(transport, repository)
  const { phase } = access
  const grants = phase.kind === "ready" ? phase.grants : []
  return (
    <Group title="Cloud access" footer={CLOUD_ACCESS_HINT}>
      <Row label="Project" end={picker} />
      {phase.kind === "loading" ? <p className="px-4 py-3.5 text-ui text-faint">Reading…</p> : null}
      {phase.kind === "failed" ? (
        <>
          <p className="px-4 py-3 text-label text-negative">{phase.message}</p>
          <button type="button" onClick={access.read} className="web-row flex h-12 w-full items-center px-4 text-left text-ui">Try again</button>
        </>
      ) : null}
      {phase.kind === "ready"
        ? CLOUD_ACCESS_SERVICES.map((service) => (
            <TouchService
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
        : null}
      {grants.length ? <TouchRecentUse uses={access.uses} transport={transport} onOpen={access.readUses} /> : null}
    </Group>
  )
}

function TouchService({ service, grant, busy, error, onOpen, onSave, onRemove, onEdit }: {
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
  const [token, setToken] = useState("")
  const [account, setAccount] = useState("")
  const mine = busy?.service === service ? busy.doing : undefined
  const looksRight = token.trim().length >= info.minLength
  const cancel = () => {
    setConnecting(false)
    setToken("")
    setAccount("")
    onEdit()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!looksRight || busy) return
    void onSave(token, account).then((saved) => {
      if (!saved) return
      setConnecting(false)
      setToken("")
      setAccount("")
    })
  }
  if (connecting)
    return (
      <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3.5" data-cloud-access-form={service}>
        <p className="text-ui font-medium">1. Make a token on {info.name}</p>
        <p className="text-label text-faint">{info.choose}</p>
        <button type="button" className="web-quiet-button flex h-10 items-center justify-center gap-1.5" onClick={() => onOpen(info.tokenPage)}>
          {info.name} tokens
          <ArrowUpRightIcon className="size-4" />
        </button>
        <p className="pt-1 text-ui font-medium">2. Paste it here</p>
        <input
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={500}
          value={token}
          disabled={mine === "saving"}
          placeholder={`${info.name} token`}
          aria-label={`${info.name} token`}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setToken(event.target.value)
            onEdit()
          }}
          className="web-field h-11 w-full font-mono placeholder:font-sans"
        />
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={200}
          value={account}
          disabled={mine === "saving"}
          placeholder={info.account.placeholder}
          aria-label={info.account.label}
          onChange={(event) => {
            setAccount(event.target.value)
            onEdit()
          }}
          className="web-field h-11 w-full"
        />
        <p className="text-label text-faint">{info.account.hint}</p>
        {error ? <p role="alert" className="text-label text-negative">{error}</p> : null}
        <p className="text-label text-faint">Mako Cloud checks it with {info.name}, keeps it sealed, and gives it only to this project's cloud Threads. It isn't kept on this phone.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="web-quiet-button h-10 px-4" disabled={mine === "saving"} onClick={cancel}>Cancel</button>
          <button type="submit" className="web-button h-10 px-4" disabled={!looksRight || mine === "saving"}>
            {mine === "saving" ? `Checking with ${info.name}…` : grant ? "Replace" : "Save"}
          </button>
        </div>
      </form>
    )
  if (!grant)
    return (
      <>
        <Row label={info.name} detail={info.gives} end={<button type="button" className="web-quiet-button h-9 px-3" disabled={busy !== undefined} data-cloud-access-action="connect" onClick={() => setConnecting(true)}>Connect</button>} />
        {error ? <p className="px-4 py-3 text-label text-negative">{error}</p> : null}
      </>
    )
  const expiry = expiryWords(grant.expiresAt)
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-cloud-access-service={service}>
      <div className="min-w-0">
        <p className="truncate text-ui"><span className="font-medium">{info.name}</span><span className="text-muted-foreground"> · {grantAccount(grant)}</span></p>
        <p className={cn("text-label", expiry.lapsed ? "text-negative" : "text-faint")}>{expiry.lapsed ? `${expiry.text}. Replace it to use ${info.name} again.` : expiry.text}</p>
        <p className="text-label text-faint">{lastUsedWords(grant)}</p>
      </div>
      {removing ? (
        <div className="flex flex-col gap-2 pt-1">
          <p className="text-label text-faint">Remove {info.name} from this project? Running cloud Threads lose it within a minute, and no new shell gets it.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="web-quiet-button h-9 px-3" disabled={mine === "removing"} onClick={() => setRemoving(false)}>Cancel</button>
            <button type="button" className="web-button web-button-negative h-9 px-3" disabled={busy !== undefined} onClick={() => void onRemove().then((removed) => removed && setRemoving(false))}>
              {mine === "removing" ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <button type="button" className="web-quiet-button h-9 px-3" disabled={busy !== undefined} onClick={() => setConnecting(true)}>Replace token</button>
          <button type="button" className="web-quiet-button h-9 px-3 text-negative" disabled={busy !== undefined} onClick={() => setRemoving(true)}>Remove</button>
        </div>
      )}
      {error ? <p role="alert" className="text-label text-negative">{error}</p> : null}
    </div>
  )
}

function TouchRecentUse({ uses, transport, onOpen }: { uses: CloudAccessUsesPhase; transport: CloudAccessTransport; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open && uses.kind !== "loading") onOpen()
          setOpen(!open)
        }}
        className="web-row flex h-12 w-full items-center gap-2 px-4 text-left text-ui"
      >
        <ChevronRightIcon className={cn("size-4 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
        Recent use
      </button>
      {open ? (
        <div className="px-4 pb-3">
          {uses.kind === "loading" || uses.kind === "unread" ? (
            <p className="text-label text-faint">Reading…</p>
          ) : uses.kind === "failed" ? (
            <p className="text-label text-negative">{uses.message}</p>
          ) : uses.uses.length ? (
            <ul className="flex flex-col gap-2">
              {uses.uses.map((use) => (
                <li key={`${use.service}-${use.threadId}-${use.at}`} className="flex items-baseline gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui">{usedByName(transport, use)}</p>
                    <p className="text-label text-faint">{CLOUD_ACCESS_CATALOG[use.service].name}</p>
                  </div>
                  <span className="shrink-0 text-label text-faint tabular-nums">{copyAge(Date.parse(use.at))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-label text-faint">No cloud Thread has used these yet.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** This browser as a device: on the Home Screen or not, and signing it out, confirmed in place. */
function ThisBrowser() {
  const client = useWebClient()
  const way = useInstallWay()
  const [steps, setSteps] = useState(false)
  const [confirming, setConfirming] = useState(false)
  return (
    <Group title="This browser" footer="Signing out here, or from a Mac's Settings › Account, ends it at once.">
      {way !== "none" ? (
        <button type="button" onClick={() => (way === "prompt" ? void install() : setSteps(true))} className="web-row flex min-h-12 w-full items-center gap-3 px-4 text-left text-ui">
          <SmartphoneIcon className="size-4 text-muted-foreground" />
          Add to Home Screen
        </button>
      ) : null}
      {confirming ? (
        <div className="flex min-h-12 items-center gap-2 px-4 py-2">
          <p className="min-w-0 flex-1 text-ui">Sign out of Mako on this {onIos() || navigator.maxTouchPoints > 0 ? "phone" : "browser"}?</p>
          <button type="button" className="web-quiet-button h-9 px-3" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button type="button" className="web-button web-button-negative h-9 px-3" onClick={() => void client.signOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="web-row flex h-12 w-full items-center gap-3 px-4 text-left text-ui text-negative">
          <LogOutIcon className="size-4" />
          Sign out
        </button>
      )}
      <IosInstallSheet open={steps} onDismiss={() => setSteps(false)} />
    </Group>
  )
}

const STANDING_WORDS = {
  on: "A Thread that needs you, once, and never while you're at your Mac.",
  off: "Approvals, questions, failures and finished turns.",
  denied: "Notifications are blocked for this site in the browser's settings.",
  unsupported: "This browser doesn't offer web notifications.",
  install: "On iPhone and iPad, add Mako to your Home Screen first: Share, then Add to Home Screen.",
} satisfies Record<PushStanding, string>

function Notifications() {
  const client = useWebClient()
  const [standing, setStanding] = useState<PushStanding | undefined>(undefined)
  const [quiet, setQuiet] = useState<QuietHours | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void client.push.standing().then(
      (found) => {
        setStanding(found.standing)
        setQuiet(found.quietHours)
      },
      () => setStanding("unsupported")
    )
  }, [client])
  const change = async (on: boolean) => {
    setBusy(true)
    try {
      if (on) setStanding(await client.push.enable(quiet))
      else {
        await client.push.disable()
        setStanding("off")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const setHours = async (next: QuietHours | null) => {
    setQuiet(next)
    await client.push.setQuietHours(next).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
  }
  const available = standing === "on" || standing === "off"
  return (
    <Group title="Notifications" footer={standing ? STANDING_WORDS[standing] : undefined}>
      <Row
        label="When a Thread needs you"
        icon={standing === "on" ? <BellIcon className="size-4" /> : standing === "install" ? <ShareIcon className="size-4" /> : <BellOffIcon className="size-4" />}
        end={<Switch on={standing === "on"} onChange={(on) => void change(on)} label="Notify this browser when a Thread needs you" disabled={!available || busy} />}
      />
      {standing === "on" ? (
        <Row
          label="Quiet hours"
          detail={quiet ? `Held from ${quiet.start} to ${quiet.end}, then sent if still true` : "Off"}
          icon={<MoonIcon className="size-4" />}
          end={<Switch on={quiet !== null} onChange={(on) => void setHours(on ? DEFAULT_QUIET : null)} label="Quiet hours" />}
        />
      ) : null}
      {standing === "on" && quiet ? (
        <div className="flex items-center gap-3 px-4 py-2.5">
          <label className="flex flex-1 items-center justify-between gap-2 text-ui">
            From
            <input type="time" value={quiet.start} onChange={(event) => void setHours({ ...quiet, start: event.target.value })} className="web-field h-9 w-28" />
          </label>
          <label className="flex flex-1 items-center justify-between gap-2 text-ui">
            To
            <input type="time" value={quiet.end} onChange={(event) => void setHours({ ...quiet, end: event.target.value })} className="web-field h-9 w-28" />
          </label>
        </div>
      ) : null}
    </Group>
  )
}

const THEMES: Array<{ value: WebTheme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

function Appearance() {
  const [theme, setTheme] = useTheme()
  return (
    <Group title="Appearance">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 p-1.5">
        {THEMES.map((each) => (
          <button
            key={each.value}
            type="button"
            role="radio"
            aria-checked={theme === each.value}
            onClick={() => setTheme(each.value)}
            className={cn("pressable h-9 rounded-xl text-ui", theme === each.value ? "bg-fill-selected font-medium text-foreground" : "text-muted-foreground")}
          >
            {each.label}
          </button>
        ))}
      </div>
    </Group>
  )
}

/** What someone debugging the web reads first: who this browser is, where the list stands, and the last failure to quote. */
function Diagnostics() {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const readings = useReadings((state) => state.readings)
  const lines: Array<[string, string]> = [
    ["Device", client.deviceId],
    ["Account", client.account.id],
    ["List", `${list.phase}${list.seq === undefined ? "" : ` at ${list.seq}`}${list.asOf ? `, ${copyAge(list.asOf)}` : ""}`],
    ["Rows", String(list.rows.length)],
  ]
  if (list.failure) lines.push(["Last failure", `${list.failure.message} (${copyAge(list.failure.at)})${list.failure.correlationId ? ` · ${list.failure.correlationId}` : ""}`])
  // How this browser follows the account's devices: the list's stream, then each conversation it followed, latest first.
  const sync = webSync.readings()
  lines.push(["Sync", describeList(sync.list)])
  for (const follow of [...sync.follows].sort((left, right) => (right.lastHeardAt ?? 0) - (left.lastHeardAt ?? 0)).slice(0, 3))
    lines.push([follow.label ?? "Live", describeFollow(follow)])
  // Each continue in the cloud this browser pressed or the list says, latest first, as a move's steps would read.
  for (const reading of continueReadings(webContinues.readings(), list.rows).slice(0, 3)) lines.push([reading.title ? `Continue · ${reading.title}` : "Continue", describeContinue(reading)])
  if (client.options.build) lines.push(["Build", client.options.build])
  // How the app ran on this device lately, newest first: a few here, every one kept in what Copy takes.
  const said = readings.toReversed().map((reading): [string, string] => [new Date(reading.at).toLocaleTimeString([], { hour12: false }), readingWords(reading)])
  lines.push(...said.slice(0, READINGS_SHOWN))
  const text = [...lines, ...said.slice(READINGS_SHOWN)].map(([label, value]) => `${label}: ${value}`).join("\n")
  return (
    <Group title="Diagnostics">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 font-mono text-label">
        {lines.map(([label, value], index) => (
          <div key={`${index}-${label}`} className="contents">
            <dt className="text-faint">{label}</dt>
            <dd className="min-w-0 wrap-anywhere text-muted-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))} className="web-row flex h-11 w-full items-center gap-3 px-4 text-left text-ui">
        <CopyIcon className="size-4 text-muted-foreground" />
        Copy diagnostics
      </button>
    </Group>
  )
}
