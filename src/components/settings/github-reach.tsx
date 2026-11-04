import { Fragment, useState, type FormEvent } from "react"
import { CircleAlertIcon, PlusIcon } from "lucide-react"
import { GITHUB_REACH_HINT, GITHUB_REACH_LIMIT, GITHUB_REACH_TITLE, typedReachRepository, type GitHubAsk, type GitHubAskAnswer, type GitHubAskOutcome, type GitHubReach as Reach, type GitHubReachMode } from "@mako/host/contracts/github-reach"
import { Action, Eyebrow, ListCard, ListCardRow } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { copyAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  askerName,
  projectName,
  reachChoices,
  reachOwner,
  settledWords,
  useGitHubAsks,
  useGitHubReach,
  withoutRepository,
  withRepository,
  type GitHubReachTransport,
} from "@/state/github-reach"

const inputClass =
  "h-8 min-w-0 flex-1 rounded-md bg-raised px-2.5 text-ui text-foreground ring-1 ring-hairline placeholder:text-faint focus:outline-none focus-visible:ring-border"

/** What every list of asks answers with: which is being answered, the last refusal, and the answers that landed. */
export type AskAnswers = {
  answering: { id: string; answer: GitHubAskAnswer } | undefined
  refusal: { id: string; message: string } | undefined
  settled: GitHubAskOutcome[]
  answer: (ask: GitHubAsk, answer: GitHubAskAnswer) => Promise<boolean>
}

/**
 * A project's "GitHub repositories" in Mako Cloud (Settings › Apps › a project, beside Access): which repositories its
 * cloud Threads can read besides their own, as one of three choices, and above them, whenever any are pending, the asks
 * its running Threads made for more, each answered with one tap. The desktop's, and a laptop browser's Settings too,
 * where `asks` is off because every project's asks are listed at the top.
 */
export function GitHubReach({ transport, repository, asks: showAsks = true, nudge }: { transport: GitHubReachTransport; repository: string; asks?: boolean; nudge?: number }) {
  const reach = useGitHubReach(transport, repository, nudge)
  const { phase } = reach
  return (
    <section className="flex flex-col gap-2" data-github-reach={repository}>
      <div className="flex flex-col gap-0.5">
        <Eyebrow>{GITHUB_REACH_TITLE}</Eyebrow>
        <p className="px-1 text-label leading-relaxed text-faint">{GITHUB_REACH_HINT}</p>
      </div>
      {showAsks ? <AskList transport={transport} asks={reach.asks} answers={reach} /> : null}
      <ListCard>
        {phase.kind === "loading" ? (
          <ListCardRow className="text-ui text-faint"><Shimmer text="Reading…" /></ListCardRow>
        ) : phase.kind === "failed" ? (
          <ListCardRow className="flex items-center gap-2 text-label">
            <CircleAlertIcon className="size-3.5 shrink-0 text-caution" />
            <span className="min-w-0 flex-1 text-muted-foreground">{phase.message}</span>
            <Action size="xs" onClick={reach.read}>Try again</Action>
          </ListCardRow>
        ) : (
          <Choices key={phase.reach.mode} repository={repository} reach={phase.reach} saving={reach.saving} error={reach.error} onSave={reach.save} onEdit={reach.clearError} />
        )}
      </ListCard>
    </section>
  )
}

/**
 * The three choices. "These repositories" opens its list where it's chosen; picked while another is saved, it waits
 * for the first repository before it changes anything.
 */
function Choices({ repository, reach, saving, error, onSave, onEdit }: {
  repository: string
  reach: Reach
  saving: boolean
  error: string | undefined
  onSave: (reach: Reach) => Promise<boolean>
  onEdit: () => void
}) {
  const [picked, setPicked] = useState<GitHubReachMode>(reach.mode)
  const choose = (mode: GitHubReachMode) => {
    onEdit()
    setPicked(mode)
    if (mode !== "chosen" && mode !== reach.mode) void onSave({ mode }).then((saved) => saved || setPicked(reach.mode))
  }
  return (
    <>
      <ListCardRow role="radiogroup" aria-label={GITHUB_REACH_TITLE} className="flex flex-col gap-0.5 py-2 first:pt-2 last:pb-2">
        {reachChoices(repository).map((choice) => (
          <button
            key={choice.mode}
            type="button"
            role="radio"
            aria-checked={picked === choice.mode}
            disabled={saving}
            data-github-reach-mode={choice.mode}
            onClick={() => choose(choice.mode)}
            className="pressable -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-ui hover:not-disabled:bg-fill-hover disabled:opacity-60"
          >
            <span aria-hidden className={cn("flex size-3 shrink-0 items-center justify-center rounded-full ring-1 ring-inset", picked === choice.mode ? "ring-foreground" : "ring-border")}>
              {picked === choice.mode ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
            </span>
            <span className={cn("min-w-0 flex-1", picked === choice.mode ? "font-medium text-foreground" : "text-foreground/85")}>{choice.label}</span>
            {saving && picked === choice.mode && choice.mode !== "chosen" ? <Shimmer text="Saving…" className="text-label" /> : null}
          </button>
        ))}
      </ListCardRow>
      {picked === "chosen" ? <Chosen repository={repository} reach={reach} saving={saving} onSave={onSave} onEdit={onEdit} /> : null}
      {error ? (
        <ListCardRow>
          <p role="alert" className="flex items-start gap-1.5 text-label text-negative">
            <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        </ListCardRow>
      ) : null}
    </>
  )
}

function Chosen({ repository, reach, saving, onSave, onEdit }: { repository: string; reach: Reach; saving: boolean; onSave: (reach: Reach) => Promise<boolean>; onEdit: () => void }) {
  const [typed, setTyped] = useState("")
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const chosen = reach.mode === "chosen" ? reach.repositories : []
  const full = chosen.length >= GITHUB_REACH_LIMIT
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!typed.trim() || saving || full) return
    const parsed = typedReachRepository(typed, repository)
    if ("refused" in parsed) return setRefused(parsed.refused)
    void onSave(withRepository(reach, parsed.repository)).then((saved) => saved && setTyped(""))
  }
  return (
    <>
      {chosen.map((name) => (
        <ListCardRow key={name} className="py-2 first:pt-2.5 last:pb-2.5">
          <div className="flex items-center gap-3" data-github-reach-repository={name}>
            <span className="min-w-0 flex-1 truncate font-mono text-label text-foreground">{name}</span>
            <span className="shrink-0 text-label text-faint">Read</span>
            <Action size="xs" className="shrink-0 text-muted-foreground" disabled={saving} onClick={() => void onSave(withoutRepository(reach, name))}>Remove</Action>
          </div>
        </ListCardRow>
      ))}
      <ListCardRow>
        <form onSubmit={submit} className="flex flex-col gap-1.5" data-github-reach-add>
          <span className="flex items-center gap-2">
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={typed}
              disabled={saving || full}
              placeholder={`A repository under ${reachOwner(repository)}, as owner/name`}
              aria-label="Repository to add"
              aria-invalid={refused ? true : undefined}
              onChange={(event) => {
                setTyped(event.target.value)
                setRefused(undefined)
                onEdit()
              }}
              className={cn(inputClass, "font-mono placeholder:font-sans", refused && "ring-negative/60")}
            />
            <Action size="sm" tone="outline" type="submit" disabled={!typed.trim() || saving || full}>
              <PlusIcon />
              {saving ? "Saving…" : "Add"}
            </Action>
          </span>
          {refused ? <span role="alert" className="text-label text-negative">{refused}</span> : null}
          <span className="text-label text-faint">
            {full
              ? `That's the most a project can have, ${GITHUB_REACH_LIMIT}. Remove one to add another.`
              : chosen.length
                ? `${chosen.length} of at most ${GITHUB_REACH_LIMIT}, read-only. ${projectName(repository)} is always theirs.`
                : reach.mode === "chosen"
                  ? "None yet: cloud Threads read only this repository."
                  : "Add the first to switch to these. Until then nothing changes."}
          </span>
        </form>
      </ListCardRow>
    </>
  )
}

/** Pending asks as rows, each answered with one tap, and each answer that landed while the screen was open. */
export function AskList({ transport, asks, answers, projects }: { transport: GitHubReachTransport; asks: GitHubAsk[]; answers: AskAnswers; projects?: boolean }) {
  if (!asks.length && !answers.settled.length) return null
  return (
    <ListCard data-github-asks>
      {asks.map((ask) => (
        <AskRow key={ask.id} transport={transport} ask={ask} answers={answers} project={projects ? projectName(ask.repository) : undefined} />
      ))}
      {answers.settled.map((outcome) => (
        <ListCardRow key={outcome.ask.id} className="flex items-baseline gap-3 py-2.5 first:pt-3 last:pb-3">
          <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
            {askerName(transport, outcome.ask)} · <RepositoryNames names={outcome.ask.repositories} />
          </span>
          <span className={cn("shrink-0 text-label", outcome.already ? "text-caution" : "text-faint")}>{settledWords(outcome)}</span>
        </ListCardRow>
      ))}
    </ListCard>
  )
}

function AskRow({ transport, ask, answers, project }: { transport: GitHubReachTransport; ask: GitHubAsk; answers: AskAnswers; project?: string }) {
  const mine = answers.answering?.id === ask.id ? answers.answering.answer : undefined
  const busy = answers.answering !== undefined
  const refusal = answers.refusal?.id === ask.id ? answers.refusal.message : undefined
  const button = (answer: GitHubAskAnswer, label: string, tone: "outline" | "ghost") => (
    <Action size="xs" tone={tone} disabled={busy} data-github-ask-answer={answer} onClick={() => void answers.answer(ask, answer)}>
      {mine === answer ? "…" : label}
    </Action>
  )
  return (
    <ListCardRow data-github-ask={ask.id}>
      <div className="flex items-baseline gap-3">
        <p className="min-w-0 flex-1 text-ui leading-relaxed text-foreground [overflow-wrap:anywhere]">
          <span className="font-medium">{askerName(transport, ask)}</span> asks to read <RepositoryNames names={ask.repositories} />
          {ask.why ? <span className="text-muted-foreground">: {ask.why}</span> : null}
        </p>
        <span className="shrink-0 text-label text-faint tabular-nums">{copyAge(Date.parse(ask.askedAt))}</span>
      </div>
      {project ? <p className="mt-0.5 text-label text-faint">In {project}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {button("thread", "Allow for this Thread", "outline")}
        {button("project", "Allow for the project", "outline")}
        {button("decline", "Decline", "ghost")}
      </div>
      {refusal ? <p role="alert" className="mt-2 text-label text-negative">{refusal}</p> : null}
    </ListCardRow>
  )
}

/**
 * Every project's pending asks, for the top of the web app's Settings in a laptop's browser; nothing while there are
 * none. `onAnswered` hears each answer, so the project shown below reads its reach again.
 */
export function GitHubAsks({ transport, onAnswered }: { transport: GitHubReachTransport; onAnswered?: (outcome: GitHubAskOutcome) => void }) {
  const asks = useGitHubAsks(transport, onAnswered)
  if (!asks.asks.length && !asks.settled.length) return null
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <Eyebrow>Cloud Threads asking for GitHub repositories</Eyebrow>
        <p className="px-1 text-label leading-relaxed text-faint">Read-only. Allow one for the Thread while it lives, or add it to the project's repositories.</p>
      </div>
      <AskList transport={transport} asks={asks.asks} answers={asks} projects />
    </section>
  )
}

/** An ask's repositories as `repositoriesWords` says them, each name in the code face and the words between in the text's. */
export function RepositoryNames({ names }: { names: readonly string[] }) {
  const shown = names.length > 3 ? names.slice(0, 2) : names
  const rest = names.length - shown.length
  return (
    <>
      {shown.map((name, index) => (
        <Fragment key={name}>
          {index ? (index === shown.length - 1 && !rest ? " and " : ", ") : null}
          <span className="font-mono text-label">{name}</span>
        </Fragment>
      ))}
      {rest ? ` and ${rest} more` : null}
    </>
  )
}
