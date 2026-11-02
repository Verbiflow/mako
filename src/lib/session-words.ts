import { lastWorked, sessionStanding, type SessionFacts, type SessionStanding } from "@mako/host/contracts/session-choice"
import { copyAge, formatDay, formatRelative } from "@/lib/format"

/** A Session's standing in words, as every client says it beside its name. */
export const STANDING_WORDS = {
  working: "Working",
  waiting: "Waiting on you",
  failed: "Failed",
  moving: "Moving",
  idle: "Idle",
  asleep: "Asleep",
} as const satisfies Record<SessionStanding, string>

/** A Session's own name: its harness's title for it, else its harness's name. Never its Thread's title. */
export function sessionName(facts: Pick<SessionFacts, "title">, harness: string): string {
  return facts.title?.trim() || harness
}

/** Who a Session is in a short phrase, its harness and whether it's a fork: "Cursor", "Cursor fork". */
export function sessionWho(facts: Pick<SessionFacts, "fork">, harness: string): string {
  return facts.fork ? `${harness} fork` : harness
}

/**
 * A Session called by who it is and its own name, wherever a sentence names the one a message goes to: "Cursor · Ship
 * the session picker", "Cursor fork · Thread Environments", "Claude Code" when it has no name of its own.
 */
export function sessionCalled(facts: Pick<SessionFacts, "title" | "fork">, harness: string): string {
  const name = sessionName(facts, harness)
  const who = sessionWho(facts, harness)
  return name === harness ? who : `${who} · ${name}`
}

/**
 * The name of the Session `facts` was forked from, when it's one of `sessions` (a parent archived or listed nowhere
 * has none here).
 */
export function forkedFrom(facts: Pick<SessionFacts, "forkOf">, sessions: readonly SessionFacts[], label: (harness: string) => string): string | undefined {
  const parent = facts.forkOf === undefined ? undefined : sessions.find((session) => session.id === facts.forkOf)
  return parent && sessionName(parent, label(parent.harness))
}

/** "Fork of Ship the session picker", or "Fork" when its parent isn't known or shares its name. */
function forkPhrase(facts: SessionFacts, parent: string | undefined, harness: string): string | undefined {
  if (!facts.fork) return undefined
  return parent && parent !== sessionName(facts, harness) ? `Fork of ${parent}` : "Fork"
}

/** When the person last worked in it, for a sentence: "last message 4 minutes ago", "started 2 hours ago". */
export function workedPhrase(facts: SessionFacts, now: number): string {
  const at = lastWorked(facts)
  const verb = facts.promptedAt !== undefined ? "last message" : facts.harnessWroteAt !== undefined ? "active" : "started"
  return `${verb} ${copyAge(at, now)}`
}

/**
 * The line under a Session's name wherever Sessions are listed: "Fork of Ship the session picker · Asleep · last
 * message 20 days ago". `parent` is the name of the Session it was forked from (`forkedFrom`).
 */
export function sessionDetail(facts: SessionFacts, now: number, harness: string, parent?: string): string {
  return [forkPhrase(facts, parent, harness), STANDING_WORDS[sessionStanding(facts, now)], workedPhrase(facts, now)].filter(Boolean).join(" · ")
}

/** The same at a bar's width, beside its name: "Fork · Asleep · Oct 12", "Idle · 4h". */
export function sessionBrief(facts: SessionFacts, now: number, harness: string, parent?: string): string {
  return [forkPhrase(facts, parent, harness), standingBrief(facts, now)].filter(Boolean).join(" · ")
}

/** How it stands and since when, at a bar's width: "Asleep · Oct 12", "Idle · 4h". */
export function standingBrief(facts: SessionFacts, now: number): string {
  return `${STANDING_WORDS[sessionStanding(facts, now)]} · ${formatRelative(lastWorked(facts))}`
}

/**
 * Where the composer's words go, said quietly by the composer of a Thread with more than one Session: "To Cursor · Ship
 * the session picker". The same words name a Fin or the Thread's Apex wherever a message can go to one of several.
 */
export function sendsToWords(facts: Pick<SessionFacts, "title" | "fork">, harness: string): string {
  return `To ${sessionCalled(facts, harness)}`
}

/** How long a resting Session has rested, for a sentence: "20 days", "a day", "5 hours". */
export function restedFor(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  if (hours < 24) return hours <= 1 ? "an hour" : `${hours} hours`
  const days = Math.floor(hours / 24)
  return days === 1 ? "a day" : `${days} days`
}

/**
 * The line that asks before a send to an asleep Session the screen opened on by itself while a newer one exists
 * (`staleTarget`): "Send to Cursor fork, idle 20 days?", then the newer one, "Newest: Cursor · Ship the session picker,
 * last message 4 hours ago".
 */
export function staleSendWords(target: SessionFacts, newest: SessionFacts, label: (harness: string) => string, now: number) {
  return {
    title: `Send to ${sessionWho(target, label(target.harness))}, idle ${restedFor(now - lastWorked(target))}?`,
    newest: `Newest: ${sessionCalled(newest, label(newest.harness))}, ${workedPhrase(newest, now)}`,
  }
}

/**
 * A message that woke a Session after a long rest, above it in the transcript: "Sent to this Cursor session, idle since
 * Oct 12", "20 days without a message". The title alone says both on a phone's width.
 */
export function wokeWords(who: string, restedMs: number, lastAt: number) {
  return { title: `Sent to this ${who}, idle since ${formatDay(lastAt)}`, detail: `${restedFor(restedMs)} without a message` }
}
