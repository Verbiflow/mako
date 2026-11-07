import { useEffect, useMemo, useState, type FormEvent } from "react"
import { continueReadings, describeContinue } from "@mako/host/contracts/cloud-continues"
import { describeFollow, describeList } from "@mako/host/contracts/sync-readings"
import { webContinues } from "./continue-actions"
import { readingWords, useReadings } from "./probe"
import { webSync } from "./sync-readings"
import { ArrowUpRightIcon, BellIcon, BellOffIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, GitPullRequestIcon, LogOutIcon, MoonIcon, ShareIcon, SmartphoneIcon } from "lucide-react"
import { MAKO_GITHUB_APP, NEW_PERSON_TOKEN_URL, PERSON_TOKEN, PERSON_TOKEN_PERMISSIONS } from "@mako/host/contracts/github-person"
import type { CommitAuthor } from "@mako/host/contracts/github-authorship"
import { PullRequestsAsMe } from "@/components/settings/pull-requests-as-me"
import { expiryWords, useGitHubToken, type GitHubTokens } from "@/state/github-token"
import { AUTHORSHIP_UNAVAILABLE, AUTHORSHIP_UNREAD, authorshipChoosable, authorshipWords, FALLBACK_WORDS, TOKEN_KEPT_WORDS, useGitHubAuthorship, type GitHubAuthorships } from "@/state/github-authorship"
import { webGitHubTokens } from "./github-tokens"
import { webGitHubAuthorships } from "./github-authorship"
import { useForm } from "./route"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { copyAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { projectOf } from "./threads"
import { useWebClient } from "./client"
import type { PushStanding, QuietHours } from "./push"
import { install, onIos, useInstallWay } from "./install"
import { IosInstallSheet } from "./install-card"
import { useTheme, type WebTheme } from "./theme"
import { setPref, usePrefs } from "@/state/prefs"
import { Group, Row, Switch } from "./settings-rows"
import { Fins } from "./fins"
import { WebDevices } from "./devices"

const DEFAULT_QUIET: QuietHours = { start: "22:00", end: "07:00" }
/** The device's latest readings Diagnostics lists; Copy takes every one kept. */
const READINGS_SHOWN = 8

/** Settings: a screen of its own on a phone, Back to the list; wide, the pane beside the rail, opened from its foot. */
export function Settings({ onBack, onSetup }: { onBack: (() => void) | undefined; onSetup?: (project: string) => void }) {
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
          {onSetup ? <Setups onOpen={onSetup} /> : null}
          <Notifications />
          <Conversation />
          <Fins />
          <WebDevices />
          <PullRequests />
          <Appearance />
          <ThisBrowser />
          <Diagnostics />
        </div>
      </div>
    </div>
  )
}

/** Each project's Setup, one row a project: what each place has for it, and where agents' asks wait. */
function Setups({ onOpen }: { onOpen: (project: string) => void }) {
  const rows = useAccountList((state) => state.rows)
  const projects = useMemo(() => [...new Set(rows.map((row) => projectOf(row.folder)).filter((name): name is string => Boolean(name)))].sort(), [rows])
  if (!projects.length) return null
  return (
    <Group title="Setup" footer="What each place has for a project, from your Mac to the cloud. Agents ask here; only your tap adds.">
      {projects.map((project) => (
        <button key={project} type="button" data-setup-project={project} onClick={() => onOpen(project)} className="pressable text-left">
          <Row label={project} end={<ChevronRightIcon aria-hidden className="size-4 text-faint" />} />
        </button>
      ))}
    </Group>
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
 * Who cloud commits and pull requests are authored as, and "Open pull requests as me". In a laptop's browser it's the
 * desktop's own Settings group (`PullRequestsAsMe`); on a phone or tablet, the same settings in the touch layout here.
 * Both read and change the account's, never keep the token.
 */
function PullRequests() {
  const client = useWebClient()
  const tokens = useMemo(() => webGitHubTokens(client.gateway, client.account.id), [client])
  const authorships = useMemo(() => webGitHubAuthorships(client.gateway, client.account.id), [client])
  if (useForm() === "desk") return <PullRequestsAsMe tokens={tokens} authorships={authorships} />
  return <TouchPullRequests tokens={tokens} authorships={authorships} />
}

const AUTHORS: Array<{ value: CommitAuthor; label: string }> = [
  { value: "you", label: "As you" },
  { value: "mako", label: "As Mako" },
]

export function TouchPullRequests({ tokens, authorships }: { tokens: GitHubTokens; authorships: GitHubAuthorships }) {
  const { phase, busy, error, save, remove, read, clearError } = useGitHubToken(tokens)
  const authorship = useGitHubAuthorship(authorships)
  const [asking, setAsking] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)
  const [token, setToken] = useState("")
  const listing = phase.kind === "ready" ? phase.listing : null
  const expiry = listing ? expiryWords(listing.expiresAt) : undefined
  const as = authorship.phase.kind === "ready" ? authorship.phase.authorship.as : undefined
  const hasToken = phase.kind === "ready" ? Boolean(listing) : undefined
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
    : as === "mako"
      ? "While this is As Mako, a saved token is kept but not used. Pull requests from your Mac always use your own GitHub sign-in."
      : listing
        ? "Your cloud Threads push, open and merge with your GitHub token. Turning this off deletes it from Mako Cloud."
        : "Pull requests from your Mac always use your own GitHub sign-in."
  return (
    <Group title="Commits and pull requests" footer={asking ? undefined : footer}>
      <div className="flex flex-col gap-2.5 px-4 py-3">
        <div>
          <p className="text-ui">Commits and pull requests</p>
          <p className="text-label text-faint">{as ? authorshipWords(as, hasToken) : authorship.phase.kind === "failed" ? AUTHORSHIP_UNREAD : authorship.phase.kind === "unavailable" ? AUTHORSHIP_UNAVAILABLE : "From cloud Threads"}</p>
        </div>
        {authorshipChoosable(authorship.phase) ? (
          <div role="radiogroup" aria-label="Commits and pull requests" className="grid grid-cols-2 gap-1 bg-raised p-1">
            {AUTHORS.map((each) => (
              <button
                key={each.value}
                type="button"
                role="radio"
                aria-checked={as === each.value}
                disabled={authorship.phase.kind !== "ready" || authorship.saving}
                onClick={() => void authorship.choose(each.value)}
                className={cn("pressable h-9 text-ui disabled:opacity-50", as === each.value ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted-foreground")}
              >
                {each.label}
              </button>
            ))}
          </div>
        ) : null}
        {authorship.error ? <p role="alert" className="text-label text-negative">{authorship.error}</p> : null}
      </div>
      {authorship.phase.kind === "failed" ? (
        <button type="button" onClick={authorship.read} className="web-row flex h-12 w-full items-center px-4 text-left text-ui">Try again</button>
      ) : null}
      {authorship.phase.kind === "ready" && as === "you" && hasToken === false && !asking ? (
        <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
          <p className="min-w-0 flex-1 text-label text-muted-foreground">{FALLBACK_WORDS}</p>
          <button type="button" className="web-quiet-button h-9 shrink-0 px-3" onClick={() => setAsking(true)}>Add token</button>
        </div>
      ) : null}
      <Row
        label="Open pull requests as me"
        detail={listing ? (as === "mako" ? TOKEN_KEPT_WORDS : "GitHub shows you as the author") : "From cloud Threads"}
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

/** This browser as a device: on the Home Screen or not, and signing it out, confirmed in place. */
function ThisBrowser() {
  const client = useWebClient()
  const way = useInstallWay()
  const [steps, setSteps] = useState(false)
  const [confirming, setConfirming] = useState(false)
  return (
    <Group title="This browser" footer="Signing out here, or removing this browser in Settings › Devices on another device, ends it at once.">
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
            className={cn("pressable h-9 text-ui", theme === each.value ? "bg-fill-selected font-medium text-foreground" : "text-muted-foreground")}
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
