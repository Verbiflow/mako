import { useCallback, useEffect, useRef, useState } from "react"
import { GITHUB_ASKS_REREAD_MS, projectRepository, type GitHubAsk, type GitHubAskAnswer, type GitHubAskOutcome, type GitHubReach, type GitHubReachMode, type GitHubReachView } from "@mako/host/contracts/github-reach"
import { errorMessage, type FailureBoundary } from "@mako/host/contracts/error-message"
import { getMako } from "@/lib/bridge"
import { refusalWords } from "@/state/github-token"
import { threadTitle } from "@/state/thread-titles"
import { threadsStore } from "@/state/thread-store"

/**
 * A project's GitHub reach as Settings reads and changes it, the same on the desktop and in a browser: each reaches the
 * account its own way (the Mac through its host, a browser through the gateway). `repository` is always the project's
 * GitHub URL.
 */
export interface GitHubReachTransport {
  /** The project's reach and its pending asks, newest first. */
  read(repository: string): Promise<GitHubReachView>
  save(repository: string, reach: GitHubReach): Promise<GitHubReach>
  /** Every project's pending asks, newest first. */
  asks(): Promise<GitHubAsk[]>
  answer(askId: string, answer: GitHubAskAnswer): Promise<GitHubAskOutcome>
  /** A cloud Thread's name, where this device knows it. */
  threadTitle(threadId: string): string | undefined
}

/** The desktop's: through this Mac's host, signed in to the account. */
export const desktopGitHubReach: GitHubReachTransport = {
  read: (repository) => getMako().githubReach(repository),
  save: (repository, reach) => getMako().githubReachSave(repository, reach),
  asks: () => getMako().githubAsks(),
  answer: (askId, answer) => getMako().githubAskAnswer(askId, answer),
  threadTitle: (threadId) => threadTitle(threadId) ?? threadsStore.get().threads.find((ref) => ref.threadId === threadId)?.title,
}

export type GitHubReachPhase =
  | { kind: "loading" }
  | { kind: "ready"; reach: GitHubReach; asks: GitHubAsk[] }
  | { kind: "failed"; message: string }

export type GitHubAsksPhase =
  | { kind: "loading" }
  | { kind: "ready"; asks: GitHubAsk[] }
  | { kind: "failed"; message: string }

const words = (failure: FailureBoundary) => refusalWords(errorMessage(failure))

/** Runs `read` every 30 seconds while mounted, and when the window comes back to the front. */
function useRereads(read: () => void) {
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") read()
    }
    const timer = window.setInterval(again, GITHUB_ASKS_REREAD_MS)
    window.addEventListener("focus", again)
    document.addEventListener("visibilitychange", again)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", again)
      document.removeEventListener("visibilitychange", again)
    }
  }, [read])
}

/**
 * Answers to asks as this screen gave them: which one is being answered, the last refusal, and each answer as it
 * landed, kept while the screen stays open so the person sees what their tap did.
 */
function useAnswers(transport: GitHubReachTransport, landed: (outcome: GitHubAskOutcome, answer: GitHubAskAnswer) => void) {
  const [answering, setAnswering] = useState<{ id: string; answer: GitHubAskAnswer } | undefined>(undefined)
  const [refusal, setRefusal] = useState<{ id: string; message: string } | undefined>(undefined)
  const [settled, setSettled] = useState<GitHubAskOutcome[]>([])
  const answer = useCallback(async (ask: GitHubAsk, choice: GitHubAskAnswer): Promise<boolean> => {
    setAnswering({ id: ask.id, answer: choice })
    setRefusal(undefined)
    try {
      const outcome = await transport.answer(ask.id, choice)
      setSettled((current) => [outcome, ...current.filter((each) => each.ask.id !== ask.id)])
      landed(outcome, choice)
      return true
    } catch (error) {
      setRefusal({ id: ask.id, message: words({ error }) })
      return false
    } finally {
      setAnswering(undefined)
    }
  }, [transport, landed])
  return { answering, refusal, settled, answer }
}

const pendingOnly = (asks: GitHubAsk[], settled: GitHubAskOutcome[]) => asks.filter((ask) => ask.state === "pending" && !settled.some((each) => each.ask.id === ask.id))

/**
 * One project's reach as the account has it, its pending asks, and their changes. The asks are read again every 30
 * seconds and on focus; `nudge` changing reads everything again (an answer given elsewhere on the screen). Its user is
 * keyed by `repository`, so another project starts from nothing read.
 */
export function useGitHubReach(transport: GitHubReachTransport, repository: string, nudge = 0) {
  const [phase, setPhase] = useState<GitHubReachPhase>({ kind: "loading" })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const savingRef = useRef(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const reread = useCallback(() => {
    void transport.read(repository).then(
      (view) => live.current && setPhase((current) => ({ kind: "ready", reach: savingRef.current && current.kind === "ready" ? current.reach : view.reach, asks: view.asks })),
      (failure: Error) => live.current && setPhase((current) => (current.kind === "ready" ? current : { kind: "failed", message: words({ error: failure }) })),
    )
  }, [transport, repository])
  useEffect(() => reread(), [reread])
  const first = useRef(nudge)
  useEffect(() => {
    if (nudge !== first.current) reread()
  }, [nudge, reread])
  useRereads(reread)
  /** Asked again, as Try again does after a read that failed. */
  const read = useCallback(() => {
    setPhase({ kind: "loading" })
    reread()
  }, [reread])
  const save = useCallback(async (reach: GitHubReach): Promise<boolean> => {
    savingRef.current = true
    setSaving(true)
    setError(undefined)
    try {
      const saved = await transport.save(repository, reach)
      if (live.current) setPhase((current) => ({ kind: "ready", reach: saved, asks: current.kind === "ready" ? current.asks : [] }))
      return true
    } catch (failure) {
      if (live.current) setError(words({ error: failure }))
      return false
    } finally {
      savingRef.current = false
      if (live.current) setSaving(false)
    }
  }, [transport, repository])
  const landed = useCallback((outcome: GitHubAskOutcome) => {
    // An ask allowed for the project changes its chosen set.
    if (outcome.ask.state === "allowed-project") reread()
  }, [reread])
  const answers = useAnswers(transport, landed)
  const asks = phase.kind === "ready" ? pendingOnly(phase.asks, answers.settled) : []
  return { phase, asks, saving, error, read, save, clearError: () => setError(undefined), ...answers }
}

/** Every project's pending asks, read again every 30 seconds and on focus; `onAnswered` hears each answer that lands. */
export function useGitHubAsks(transport: GitHubReachTransport, onAnswered?: (outcome: GitHubAskOutcome) => void) {
  const [phase, setPhase] = useState<GitHubAsksPhase>({ kind: "loading" })
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const reread = useCallback(() => {
    void transport.asks().then(
      (asks) => live.current && setPhase({ kind: "ready", asks }),
      (failure: Error) => live.current && setPhase((current) => (current.kind === "ready" ? current : { kind: "failed", message: words({ error: failure }) })),
    )
  }, [transport])
  useEffect(() => reread(), [reread])
  useRereads(reread)
  const landed = useCallback((outcome: GitHubAskOutcome) => onAnswered?.(outcome), [onAnswered])
  const answers = useAnswers(transport, landed)
  const asks = phase.kind === "ready" ? pendingOnly(phase.asks, answers.settled) : []
  return { phase, asks, ...answers }
}

/** The project's owner as Settings names it; the URL itself for one that isn't GitHub's. */
export function reachOwner(repository: string): string {
  return projectRepository(repository)?.owner ?? repository
}

/** A project URL as `owner/name`. */
export function projectName(repository: string): string {
  const own = projectRepository(repository)
  return own ? `${own.owner}/${own.name}` : repository
}

/** The three choices, in Settings' words. */
export function reachChoices(repository: string): Array<{ mode: GitHubReachMode; label: string }> {
  return [
    { mode: "repository", label: "Only this repository" },
    { mode: "chosen", label: "These repositories" },
    { mode: "installation", label: `Every repository Mako's GitHub App can see for ${reachOwner(repository)}` },
  ]
}

/** "acme/docs", "acme/docs and acme/api", "acme/docs, acme/api and 2 more". */
export function repositoriesWords(repositories: readonly string[]): string {
  if (repositories.length <= 2) return repositories.join(" and ")
  if (repositories.length === 3) return `${repositories[0]}, ${repositories[1]} and ${repositories[2]}`
  return `${repositories[0]}, ${repositories[1]} and ${repositories.length - 2} more`
}

/** Who asks, as a row names them: the Thread's title where this device knows it. */
export function askerName(transport: Pick<GitHubReachTransport, "threadTitle">, ask: GitHubAsk): string {
  return transport.threadTitle(ask.threadId) ?? "A cloud Thread"
}

/** What an answer did, as the row says it once it lands. */
export function settledWords(outcome: GitHubAskOutcome): string {
  const said = {
    pending: "Still waiting for an answer",
    "allowed-thread": "Allowed for this Thread",
    "allowed-project": "Allowed for the project",
    declined: "Declined",
    expired: "Expired before an answer",
  }[outcome.ask.state]
  return outcome.already && outcome.ask.state !== "expired" ? `Already answered: ${said.toLowerCase()}` : said
}

/** The chosen set with one more, or one fewer. */
export function withRepository(reach: GitHubReach, repository: string): GitHubReach {
  const current = reach.mode === "chosen" ? reach.repositories : []
  return { mode: "chosen", repositories: current.some((each) => each.toLowerCase() === repository.toLowerCase()) ? current : [...current, repository] }
}

export function withoutRepository(reach: GitHubReach, repository: string): GitHubReach {
  return { mode: "chosen", repositories: reach.mode === "chosen" ? reach.repositories.filter((each) => each !== repository) : [] }
}
