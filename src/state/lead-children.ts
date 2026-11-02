import { childGroup, childStateOf, rollup, rosterChildren, sameRollup, type Rollup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import type { AgentsRedirected, AgentsRedirectInput } from "@mako/host/contracts/agents"
import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import { acp, acpStore, useAcp, type AcpState } from "@/state/acp"
import type { AcpConversation } from "@/state/acp-state"
import { createHook, createStore } from "@/state/store"
import { currentOnScreen } from "@/state/thread-sessions"
import { threads } from "@/state/threads"
import { threadsStore, useThreads } from "@/state/thread-store"
import { threadGroupsStore } from "@/state/thread-groups"

const NO_CHILDREN: readonly NativeAgent[] = []
const byThread = new WeakMap<AcpState["conversations"], Map<string, readonly NativeAgent[]>>()
const listedByThread = new WeakMap<AcpState["conversations"], Map<string, Rollup>>()

/**
 * The children a Thread leads, as its conversations' rosters carry them (`childEntry`, never a harness's roster), in
 * `orderedChildren`' order. Every Session of a lead carries the same children, so the first that holds any says them;
 * the array is the roster's own while that roster is unchanged, so a row reading it repaints only when they change.
 */
export function threadChildren(state: AcpState, thread: string | undefined): readonly NativeAgent[] {
  if (!thread) return NO_CHILDREN
  let index = byThread.get(state.conversations)
  if (!index) {
    index = new Map()
    for (const conversation of Object.values(state.conversations)) {
      if (conversation.kind !== "live" || !conversation.threadId || index.has(conversation.threadId)) continue
      const children = rosterChildren(conversation.nativeAgents)
      if (children.length) index.set(conversation.threadId, children)
    }
    byThread.set(state.conversations, index)
  }
  return index.get(thread) ?? NO_CHILDREN
}

/** As its host listed it (`LiveSummary.children`): a lead's count before this window holds its roster. */
function listedRollup(state: AcpState, thread: string): Rollup | undefined {
  let index = listedByThread.get(state.conversations)
  if (!index) {
    index = new Map()
    for (const conversation of Object.values(state.conversations))
      if (conversation.kind === "live" && conversation.threadId && conversation.children && !index.has(conversation.threadId)) index.set(conversation.threadId, conversation.children)
    listedByThread.set(state.conversations, index)
  }
  return index.get(thread)
}

/** A Thread's children counted by group: one selector for the rail's badge, the strip's count and the phone's row. */
export function threadRollup(state: AcpState, thread: string | undefined): Rollup {
  const children = threadChildren(state, thread)
  return children.length || !thread ? rollup(children) : (listedRollup(state, thread) ?? rollup(children))
}

export function useThreadRollup(thread: string | undefined): Rollup {
  return useAcp((state) => threadRollup(state, thread), sameRollup)
}

export function useThreadChildren(thread: string | undefined): readonly NativeAgent[] {
  return useAcp((state) => threadChildren(state, thread))
}

const stoppableOf = new WeakMap<readonly NativeAgent[], readonly NativeAgent[]>()

/** The children a lead's Stop all stops: any a stop can reach, queued and asking included, so none starts after its lead stops. */
export function stoppableChildren(children: readonly NativeAgent[]): readonly NativeAgent[] {
  let held = stoppableOf.get(children)
  if (!held) {
    held = children.some((child) => child.stoppable) ? children.filter((child) => child.stoppable) : NO_CHILDREN
    stoppableOf.set(children, held)
  }
  return held
}

/** How many of a lead's Threads work, and how many its Stop all reaches: what the lead's Stop asks about. */
export interface StopCounts {
  working: number
  reached: number
}

export function stopCounts(children: readonly NativeAgent[]): StopCounts {
  const reached = stoppableChildren(children)
  return { working: reached.filter((child) => childGroup(childStateOf(child)) === "working").length, reached: reached.length }
}

/** The lead's conversation the person talks to: the one on screen if it's the lead's, else any of its Sessions with children. */
export function leadConversation(state: AcpState, thread: string): AcpConversation | undefined {
  const active = state.activeKey ? state.conversations[state.activeKey] : undefined
  if (active?.threadId === thread) return active
  return Object.values(state.conversations).find((conversation) => conversation.threadId === thread && conversation.kind === "live" && rosterChildren(conversation.nativeAgents).length > 0)
}

/** A child's own conversation in this window, when it has one: what opens when its tab is pressed. */
export function childConversation(state: AcpState, child: string): AcpConversation | undefined {
  return Object.values(state.conversations).find((conversation) => conversation.threadId === child)
}

/**
 * A child opened inside its lead's Thread: the lead's strip stays, with the child's tab selected, and the child's own
 * transcript and composer are on screen. `shown` turns true once it is, and anything else on screen after that ends
 * it, as opening any other tab or row would.
 */
export interface ChildInLead {
  lead: string
  /** The lead's Thread name, for the breadcrumb and the "From …" card. */
  leadTitle: string
  child: string
  shown: boolean
}

interface LeadViewState {
  open: ChildInLead | null
}

export const leadViewStore = createStore<LeadViewState>({ open: null })

export const useLeadView = createHook(leadViewStore)

/** Open `child` in place, inside the lead's Thread: its live conversation, else its saved transcript. */
export function openChildInLead(lead: string, leadTitle: string, child: NativeAgent): void {
  const thread = child.child?.thread
  if (!thread) return
  const state = acpStore.get()
  const conversation = (child.child?.conversation ? state.conversations[child.child.conversation] : undefined) ?? childConversation(state, thread)
  leadViewStore.set({ open: { lead, leadTitle, child: thread, shown: false } })
  if (conversation) {
    acp.activate(conversation.key)
    return
  }
  const saved = threadsStore.get().threads.find((ref) => ref.threadId === thread)
  if (saved) void threads.view(saved, "native")
  else if (child.child?.path && child.child.nativeId)
    void threads.view({ harness: child.provider, nativeId: child.child.nativeId, path: child.child.path, title: child.title, threadId: thread }, "native")
}

/** Back to the lead: the Session last shown in it. */
export function backToLead(): void {
  const open = leadViewStore.get().open
  leadViewStore.set({ open: null })
  if (!open) return
  const last = threadGroupsStore.get().lastViewed[open.lead]
  const state = acpStore.get()
  const conversation =
    Object.values(state.conversations).find((candidate) => candidate.threadId === open.lead && candidate.sessionId === last) ??
    leadConversation(state, open.lead)
  if (conversation) acp.activate(conversation.key)
}

/** Keeps the child view honest: it ends once anything else is on screen. */
export function watchLeadView(): () => void {
  const sync = () => {
    const open = leadViewStore.get().open
    if (!open) return
    const here = currentOnScreen().thread
    if (here === open.child) {
      if (!open.shown) leadViewStore.set({ open: { ...open, shown: true } })
    } else if (open.shown && here !== undefined) leadViewStore.set({ open: null })
  }
  const stops = [acpStore.subscribe(sync), threadsStore.subscribe(sync), leadViewStore.subscribe(sync)]
  return () => stops.forEach((stop) => stop())
}

/**
 * The name of the lead a transcript's Thread answers to, for the "From …" card over its brief: the lead it's open
 * in, else its edge's lead as this window lists it. Undefined when this window lists no lead for it.
 */
export function useLeadTitle(liveId: string | undefined, threadPath: string | undefined): string | undefined {
  const lead = useAcp((state) => (liveId ? state.conversations[liveId]?.parent?.thread : undefined))
  const savedLead = useThreads((state) => (threadPath && !lead ? state.threads.find((ref) => ref.path === threadPath)?.parent?.thread : undefined))
  const thread = lead ?? savedLead
  const opened = useLeadView((state) => (thread && state.open?.lead === thread ? state.open.leadTitle : undefined))
  const listed = useThreads((state) => (thread ? state.threads.find((ref) => ref.threadId === thread)?.title : undefined))
  const live = useAcp((state) => (thread ? Object.values(state.conversations).find((conversation) => conversation.threadId === thread)?.title : undefined))
  return opened ?? listed ?? live
}

/**
 * Moves a message the lead passed on to one of its Threads to another, as
 * the person's own words there (`mako:agents-redirect`). Undefined when it
 * couldn't, the person told why.
 */
export async function redirectRouted(lead: string, input: AgentsRedirectInput): Promise<AgentsRedirected | undefined> {
  if (!hasBridge()) return undefined
  try {
    const answer = await getMako().agentsRedirect(lead, input)
    if ("refused" in answer) {
      toast.error("Your message couldn't be moved", { description: answer.why })
      return undefined
    }
    return answer
  } catch (error) {
    toast.error("Your message couldn't be moved", { description: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}
