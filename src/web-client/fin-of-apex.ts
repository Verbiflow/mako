import { createContext } from "react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { accountListStore } from "./account-list"
import { sessionOf, type WebSession } from "./threads"

/** The Apex whose Fin the phone shows, for the line over its composer: what's said there, the Apex hears too. */
export const FinOfApexContext = createContext<string | undefined>(undefined)

/** How the phone opens an Apex's Fin in place, for its chips and its Agents sheet's rows alike. */
export const OpenChildContext = createContext<((agent: NativeAgent) => void) | undefined>(undefined)

/**
 * A Fin as the phone opens it: its own live conversation, on its Apex's device, listed as its Apex's Session is.
 * Undefined while its device holds no conversation for it (queued, or never started).
 */
export function childSession(apex: WebSession, agent: NativeAgent): WebSession | undefined {
  const child = agent.child
  if (!child?.conversation) return undefined
  return {
    ...apex,
    row: { ...apex.row, conversation: child.conversation, session: child.session ?? apex.row.session, thread: child.thread, harness: agent.provider, title: agent.title, waitingOn: undefined, waitingFor: undefined, capture: undefined },
    summary: {
      ...apex.summary,
      session: { ...apex.summary.session, id: child.conversation, harness: agent.provider, title: agent.title, ...(child.nativeId && { nativeId: child.nativeId }) },
      threadId: child.thread,
      ...(child.session && { sessionId: child.session }),
      parent: { thread: apex.row.thread, session: apex.row.session },
    },
    waiting: [],
  }
}

/**
 * A Fin placed on another device, as that device lists it: the row the account holds for its Thread, which is that
 * device's own Session of it. Undefined for a Fin of its Apex's own device, whose conversation is its Apex's to open.
 */
export function placedSessionOf(agent: NativeAgent): WebSession | undefined {
  const list = accountListStore.get()
  const row = list.rows.find((each) => each.thread === agent.child?.thread && each.conversation === agent.child?.conversation)
  return row && sessionOf(row, list)
}
