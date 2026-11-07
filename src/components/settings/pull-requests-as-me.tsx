import { useState, type FormEvent } from "react"
import { ArrowUpRightIcon, CircleAlertIcon, InfoIcon, KeyRoundIcon } from "lucide-react"
import { FIELD, Action, ListCard, ListCardRow, Segmented, SettingRow, Toggle } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { MAKO_GITHUB_APP, NEW_PERSON_TOKEN_URL, PERSON_TOKEN, PERSON_TOKEN_PERMISSIONS } from "@mako/host/contracts/github-person"
import { expiryWords, useGitHubToken, type GitHubTokens } from "@/state/github-token"
import { AUTHORSHIP_UNAVAILABLE, AUTHORSHIP_UNREAD, authorshipChoosable, authorshipWords, FALLBACK_WORDS, TOKEN_KEPT_WORDS, useGitHubAuthorship, type GitHubAuthorships } from "@/state/github-authorship"

const inputClass = cn(FIELD, "flex-1 font-mono placeholder:font-sans")

/**
 * Settings › Git › Commits and pull requests in the cloud. First who they're authored as, `As you` by default or `As
 * Mako`, the account's choice; under `As you` with no token saved, a line that the App opens pull requests until one
 * is. Then "Open pull requests as me", off by default. Turning it on asks for the person's own GitHub token, which the
 * cloud checks with GitHub (and against `repository`, the one in view) before it keeps it; then the row says whose it
 * is and when it lapses. Turning it off, confirmed in place, deletes it from the account and every cloud machine. The
 * desktop's, and a laptop browser's Settings too.
 */
export function PullRequestsAsMe({ tokens, authorships, repository }: { tokens: GitHubTokens; authorships: GitHubAuthorships; repository?: string }) {
  const { phase, busy, error, save, remove, read, clearError } = useGitHubToken(tokens)
  const authorship = useGitHubAuthorship(authorships)
  const [asking, setAsking] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)
  const listing = phase.kind === "ready" ? phase.listing : null
  const on = Boolean(listing) || asking
  const expiry = listing ? expiryWords(listing.expiresAt) : undefined
  const asMako = authorship.phase.kind === "ready" && authorship.phase.authorship.as === "mako"
  const cancel = () => {
    setAsking(false)
    clearError()
  }
  return (
    <section id="pull-requests" className="flex scroll-mt-9 flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">Commits and pull requests in the cloud</h3>
        <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
          Who GitHub shows for what cloud Threads commit and open. Your Mac uses your own Git identity and GitHub sign-in.
        </p>
      </div>
      <ListCard>
        <CommitAuthorship authorship={authorship} hasToken={phase.kind === "ready" ? Boolean(listing) : undefined} asking={asking} onAddToken={() => setAsking(true)} />
        <SettingRow
          title="Open pull requests as me"
          description={
            asMako
              ? listing ? TOKEN_KEPT_WORDS : "Used once commits and pull requests are as you."
              : listing ? "Cloud Threads push, open and merge with your GitHub token, so GitHub shows you as the author." : "Use your own GitHub token, so GitHub shows you as the author instead of the app."
          }
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

/** `As you` or `As Mako`, and under `As you` without a token, that the App opens pull requests until one is saved. */
function CommitAuthorship({ authorship, hasToken, asking, onAddToken }: {
  authorship: ReturnType<typeof useGitHubAuthorship>
  /** Undefined until the token's state is known. */
  hasToken: boolean | undefined
  asking: boolean
  onAddToken: () => void
}) {
  const { phase, saving, error, choose, read } = authorship
  const as = phase.kind === "ready" ? phase.authorship.as : undefined
  return (
    <>
      <SettingRow title="Commits and pull requests" description={as ? authorshipWords(as, hasToken) : phase.kind === "unavailable" ? AUTHORSHIP_UNAVAILABLE : phase.kind === "failed" ? AUTHORSHIP_UNREAD : undefined}>
        {phase.kind === "failed" ? <Action size="xs" onClick={read}>Try again</Action> : null}
        {authorshipChoosable(phase) ? (
          <Segmented
            label="Commits and pull requests"
            value={as}
            disabled={phase.kind !== "ready" || saving}
            options={[{ value: "you", label: "As you" }, { value: "mako", label: "As Mako" }]}
            onChange={(next) => void choose(next)}
          />
        ) : null}
      </SettingRow>
      {phase.kind === "ready" && as === "you" && hasToken === false && !asking ? (
        <ListCardRow className="flex items-center gap-2 text-label">
          <InfoIcon className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 text-muted-foreground">{FALLBACK_WORDS}</span>
          <Action size="xs" tone="outline" onClick={onAddToken}>Add token</Action>
        </ListCardRow>
      ) : null}
      {error ? <ListCardRow className="text-label text-negative"><p role="alert">{error}</p></ListCardRow> : null}
    </>
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
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 bg-raised/60 px-3 py-2 text-label">
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
