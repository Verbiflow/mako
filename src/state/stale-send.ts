import type { ProposedPlan } from "@mako/sessions/content"
import { staleTarget, type SessionFacts } from "@mako/host/contracts/session-choice"
import { harnessLabel } from "@/lib/harness-label"
import { staleSendWords } from "@/lib/session-words"
import { acpStore } from "@/state/acp-state"
import { appendRecoveredDraft, clearCapturedDraft, draftsStore } from "@/state/drafts"
import { createHook, createStore } from "@/state/store"
import { threadGroupsStore } from "@/state/thread-groups"
import { currentOnScreen, currentThreadTabs, noteOpenedByScreen, openedBy, openSessionTab, sessionPromptedAt, sessionTabFacts, type SessionTab } from "@/state/thread-sessions"

/**
 * A send to a Session this window opened by itself, asleep while the person has worked in a newer one of its Thread
 * since (`staleTarget`): held, the words kept, until the line above the composer says which (`useStaleSendNotice`).
 * "Send here" sends, the Session now the person's pick; "Switch to the newest" opens the newer one with the words,
 * carried into its field once it's on screen.
 */
interface StaleSendState {
  asking?: { session: string; harness: string; newest: string; title: string; detail: string }
  carrying?: { to: string; text: string; plans?: ProposedPlan[] }
}

export const staleSendStore = createStore<StaleSendState>({})
export const useStaleSend = createHook(staleSendStore)

type SessionTabOf = Extract<SessionTab, { kind: "session" }>

function threadFacts(thread: string): Array<{ tab: SessionTabOf; facts: SessionFacts }> {
  const group = threadGroupsStore.get().groups[thread]
  const acp = acpStore.get()
  return currentThreadTabs(thread)
    .filter((tab): tab is SessionTabOf => tab.kind === "session")
    .map((tab) => ({ tab, facts: sessionTabFacts(tab, group, sessionPromptedAt(acp, tab.id)) }))
}

/** Whether a send to the Session on screen asks first; when it does, the line asking shows and the send waits. */
export function asksBeforeSend(now = Date.now()): boolean {
  const { thread, session, draft } = currentOnScreen()
  if (!thread || !session || draft) return false
  const sessions = threadFacts(thread)
  const target = sessions.find((each) => each.tab.id === session)
  const newest = target && staleTarget(target.facts, sessions.map((each) => each.facts), now, openedBy(session))
  if (!target || !newest) return false
  const words = staleSendWords(target.facts, newest, harnessLabel, now)
  staleSendStore.set({ asking: { session, harness: target.facts.harness, newest: newest.id, title: words.title, detail: words.newest } })
  return true
}

/** "Send here": the person has picked this Session, and the held send goes. */
export function sendHere(): void {
  if (!staleSendStore.get().asking) return
  noteOpenedByScreen(undefined)
  staleSendStore.set({ asking: undefined })
  window.dispatchEvent(new Event("mako:composer-send"))
}

/**
 * "Switch to the newest": the newer Session opens, its field taking these words after its own. A draft holding
 * attachments stays where it is: its chips belong to its own field.
 */
export function switchToNewest(draftKey: string, carry: boolean): void {
  const { asking } = staleSendStore.get()
  const here = currentOnScreen()
  if (!asking || !here.thread) return
  const tab = currentThreadTabs(here.thread).find((each) => each.id === asking.newest)
  staleSendStore.set({ asking: undefined })
  if (!tab) return
  const saved = draftsStore.get().drafts.find((each) => each.key === draftKey)
  if (carry && saved?.text.trim()) {
    staleSendStore.set({ carrying: { to: tab.id, text: saved.text, plans: saved.plans } })
    clearCapturedDraft(draftKey, saved.text, saved.plans)
  }
  openSessionTab(tab)
}

/** Words carried to the Session now on screen, into the field it keeps under `draftKey`. */
export function receiveCarried(session: string | undefined, draftKey: string): boolean {
  const { carrying } = staleSendStore.get()
  if (!carrying || carrying.to !== session) return false
  staleSendStore.set({ carrying: undefined })
  appendRecoveredDraft(draftKey, { id: crypto.randomUUID(), key: draftKey, text: carrying.text, attachments: [], plans: carrying.plans })
  return true
}

/** The Session the composer's words went to changed: what asked for the last one no longer stands. */
export function forgetAsking(session: string | undefined): void {
  const { asking } = staleSendStore.get()
  if (asking && asking.session !== session) staleSendStore.set({ asking: undefined })
}
