import { useState, type FormEvent } from "react"
import { ArrowUpRightIcon, CircleAlertIcon, KeyRoundIcon } from "lucide-react"
import { Action, ListCard, ListCardRow, SettingRow, Toggle } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { MAKO_GITHUB_APP, NEW_PERSON_TOKEN_URL, PERSON_TOKEN, PERSON_TOKEN_PERMISSIONS } from "@mako/host/contracts/github-person"
import { expiryWords, useGitHubToken, type GitHubTokens } from "@/state/github-token"

const inputClass =
  "h-8 min-w-0 flex-1 rounded-md bg-raised px-2.5 font-mono text-ui text-foreground ring-1 ring-hairline placeholder:font-sans placeholder:text-faint focus:outline-none focus-visible:ring-border"

/**
 * Settings › Git › Pull requests in the cloud: "Open pull requests as me", off by default. Turning it on asks for the
 * person's own GitHub token, which the cloud checks with GitHub (and against `repository`, the one in view) before it
 * keeps it; then the row says whose it is and when it lapses. Turning it off, confirmed in place, deletes it from the
 * account and every cloud machine. The desktop's, and a laptop browser's Settings too.
 */
export function PullRequestsAsMe({ tokens, repository }: { tokens: GitHubTokens; repository?: string }) {
  const { phase, busy, error, save, remove, read, clearError } = useGitHubToken(tokens)
  const [asking, setAsking] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)
  const listing = phase.kind === "ready" ? phase.listing : null
  const on = Boolean(listing) || asking
  const expiry = listing ? expiryWords(listing.expiresAt) : undefined
  const cancel = () => {
    setAsking(false)
    clearError()
  }
  return (
    <section id="pull-requests" className="flex scroll-mt-9 flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">Pull requests in the cloud</h3>
        <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
          Cloud Threads open pull requests as {MAKO_GITHUB_APP} unless this is on. Your Mac uses your own GitHub sign-in.
        </p>
      </div>
      <ListCard>
        <SettingRow
          title="Open pull requests as me"
          description={listing ? "Cloud Threads push, open and merge with your GitHub token, so GitHub shows you as the author." : "Use your own GitHub token, so GitHub shows you as the author instead of the app."}
        >
          <Toggle
            label="Open pull requests as me"
            on={on}
            disabled={phase.kind !== "ready" || busy !== undefined}
            onChange={() => {
              if (listing) setConfirmingOff((value) => !value)
              else if (asking) cancel()
              else setAsking(true)
            }}
          />
        </SettingRow>
        {phase.kind === "failed" ? (
          <ListCardRow className="flex items-center gap-2 text-label">
            <CircleAlertIcon className="size-3.5 shrink-0 text-caution" />
            <span className="min-w-0 flex-1 text-muted-foreground">{phase.message}</span>
            <Action size="xs" onClick={read}>Try again</Action>
          </ListCardRow>
        ) : null}
        {listing && expiry && !asking ? (
          <ListCardRow className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui">
                Signed in as <span className="font-medium">@{listing.login}</span>
              </p>
              <p className={cn("text-label", expiry.lapsed ? "text-negative" : "text-faint")}>
                {expiry.lapsed ? `${expiry.text}. Cloud pull requests stop until you replace it.` : expiry.text}
              </p>
            </div>
            <Action size="xs" tone={expiry.lapsed ? "outline" : "quiet"} disabled={busy !== undefined} onClick={() => setAsking(true)}>
              Replace token
            </Action>
          </ListCardRow>
        ) : null}
        {confirmingOff && listing ? (
          <ListCardRow className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-label leading-relaxed text-muted-foreground">
              Delete your token from Mako Cloud? Cloud Threads go back to {MAKO_GITHUB_APP}, and turning this on again needs a token.
            </p>
            <Action size="xs" disabled={busy !== undefined} onClick={() => setConfirmingOff(false)}>Cancel</Action>
            <Action
              size="xs"
              tone="danger"
              disabled={busy !== undefined}
              onClick={() => void remove().then((removed) => removed && setConfirmingOff(false))}
            >
              {busy === "removing" ? "Turning off…" : "Turn off"}
            </Action>
          </ListCardRow>
        ) : null}
        {asking ? (
          <ListCardRow>
            <TokenForm busy={busy === "saving"} error={error} replacing={Boolean(listing)} onCancel={cancel} onOpenGitHub={() => tokens.openUrl(NEW_PERSON_TOKEN_URL)} onSave={(token) => void save(token, repository).then((saved) => saved && setAsking(false))} onEdit={clearError} />
          </ListCardRow>
        ) : null}
        {!asking && error ? <ListCardRow className="text-label text-negative">{error}</ListCardRow> : null}
      </ListCard>
    </section>
  )
}

function TokenForm({ busy, error, replacing, onCancel, onOpenGitHub, onSave, onEdit }: {
  busy: boolean
  error: string | undefined
  replacing: boolean
  onCancel: () => void
  onOpenGitHub: () => void
  onSave: (token: string) => void
  onEdit: () => void
}) {
  const [token, setToken] = useState("")
  const looksRight = PERSON_TOKEN.test(token.trim())
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (looksRight && !busy) onSave(token)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 py-1">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-ui font-medium">1. Make a fine-grained token on GitHub</p>
          <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
            Pick the repositories cloud Threads should push to, and give it these repository permissions:
          </p>
        </div>
        <Action size="xs" tone="outline" onClick={onOpenGitHub}>
          New token on GitHub
          <ArrowUpRightIcon />
        </Action>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 rounded-md bg-raised/60 px-3 py-2 text-label ring-1 ring-hairline">
        {PERSON_TOKEN_PERMISSIONS.map((permission) => (
          <div key={permission.name} className="contents">
            <dt className="text-foreground/90">{permission.name}</dt>
            <dd className="text-muted-foreground">{permission.access}</dd>
          </div>
        ))}
      </dl>
      <label className="flex flex-col gap-1.5">
        <span className="text-ui font-medium">2. Paste it here</span>
        <span className="flex items-center gap-2">
          <KeyRoundIcon className="size-3.5 shrink-0 text-faint" />
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
            value={token}
            disabled={busy}
            placeholder="github_pat_…"
            aria-label="GitHub token"
            aria-invalid={error ? true : undefined}
            aria-describedby="github-token-note"
            onChange={(event) => {
              setToken(event.target.value)
              onEdit()
            }}
            className={cn(inputClass, error && "ring-negative/60")}
          />
          <Action size="sm" disabled={busy} onClick={onCancel}>Cancel</Action>
          <Action size="sm" tone="solid" type="submit" disabled={!looksRight || busy}>
            {busy ? "Checking with GitHub…" : replacing ? "Replace" : "Save"}
          </Action>
        </span>
      </label>
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-label text-negative">
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <p id="github-token-note" className="text-label leading-relaxed text-faint">
        Mako Cloud checks it with GitHub, keeps it encrypted, and gives it only to your cloud Threads' machines, where agents can use it. It isn't kept on this device. Turning this off deletes it everywhere.
      </p>
    </form>
  )
}
