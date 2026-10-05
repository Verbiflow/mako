import type { AccountRemovalPlan } from "@/lib/types"
import type { ConfirmRequest, ConfirmSubject } from "@/state/confirm"
import type { AccountRemovalWait } from "../../electron/account-types"

/** What each session does about the account, short enough to sit beside its title. */
const FATES = {
  background: "Waits for its background work",
  subagents: "Waits for its subagents",
  children: "Waits for its child sessions",
  approval: "Waits for your approval",
  turn: "Waits for its turn to end",
  operation: "Waits for its current step",
  close: "Keeps it until closed",
} satisfies Record<AccountRemovalWait, string>

const SHOWN_SESSIONS = 6

/**
 * The confirmation for removing an account: every session on it by name with
 * what happens to it, and when removal finishes. `selected` names the account
 * new messages use.
 */
export function removalConfirmation(label: string, account: string, selected: string, plan: AccountRemovalPlan): ConfirmRequest {
  const waiting = plan.sessions.some((session) => session.waitingFor) || plan.runs > 0 || plan.elsewhere
  const subjects: ConfirmSubject[] = plan.sessions.slice(0, SHOWN_SESSIONS).map((session) => ({
    kind: "session",
    id: session.conversation,
    name: session.title,
    detail: session.waitingFor ? FATES[session.waitingFor] : "Switches with its next message",
  }))
  const forgets = `Mako forgets this ${label} login and deletes its saved credentials from this Mac`
  const request: ConfirmRequest = {
    title: `Remove ${account}?`,
    body: !plan.sessions.length && !waiting
      ? `${forgets}. Your other logins, including the one your terminal uses, stay as they are.`
      : waiting
        ? `${forgets} once nothing uses it. Nothing is stopped${plan.sessions.length ? `; each session below switches to ${selected} as shown` : ""}.`
        : `${forgets}. ${plan.sessions.length === 1 ? `The session using it switches to ${selected} with its next message.` : `The sessions using it switch to ${selected} with their next message.`}`,
    confirm: "Remove",
    tone: "negative",
    icon: "remove",
  }
  if (subjects.length) request.subjects = subjects
  if (plan.sessions.length > SHOWN_SESSIONS) request.more = plan.sessions.length - SHOWN_SESSIONS
  const runs = plan.runs === 1 ? "A run" : `${plan.runs} runs`
  const use = plan.runs === 1 ? "uses" : "use"
  const notes = [
    plan.runs ? (plan.sessions.length ? `${runs} outside these sessions also ${use} it.` : `${runs} ${use} it.`) : "",
    plan.elsewhere ? "Another copy of Mako on this Mac is also using it." : "",
    waiting ? "Until it's removed, it can't be selected; you can keep it from its row." : "",
  ].filter(Boolean)
  if (notes.length) request.note = notes.join(" ")
  return request
}
