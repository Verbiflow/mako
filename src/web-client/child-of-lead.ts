import { createContext } from "react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import type { WebSession } from "./threads"

/** The lead whose child the phone shows, for the line over its composer: what's said there, the lead hears too. */
export const ChildOfLeadContext = createContext<string | undefined>(undefined)

/** How the phone opens a lead's child in place, for its chips and its Agents sheet's rows alike. */
export const OpenChildContext = createContext<((agent: NativeAgent) => void) | undefined>(undefined)

/**
 * A child as the phone opens it: its own live conversation, on its lead's device, listed as its lead's Session is.
 * Undefined while its device holds no conversation for it (queued, or never started).
 */
export function childSession(lead: WebSession, agent: NativeAgent): WebSession | undefined {
  const child = agent.child
  if (!child?.conversation) return undefined
  return {
    ...lead,
    row: { ...lead.row, conversation: child.conversation, session: child.session ?? lead.row.session, thread: child.thread, harness: agent.provider, title: agent.title, waitingOn: undefined, waitingFor: undefined, capture: undefined },
    summary: {
      ...lead.summary,
      session: { ...lead.summary.session, id: child.conversation, harness: agent.provider, title: agent.title, ...(child.nativeId && { nativeId: child.nativeId }) },
      threadId: child.thread,
      ...(child.session && { sessionId: child.session }),
      parent: { thread: lead.row.thread, session: lead.row.session },
    },
    waiting: [],
  }
}
