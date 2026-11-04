import { childGroup, childStateOf, rollup, rosterChildren, sameRollup, type Rollup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import type { AgentsDirected, AgentsRedirected, AgentsRedirectInput } from "@mako/host/contracts/agents"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { useMemo } from "react"
import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import { personAsks, type PersonAsk } from "@/state/fin-asks"
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
 * A Thread's Fins, as its conversations' rosters carry them (`childEntry`, never a harness's roster), in
 * `orderedChildren`' order. Every Session of an Apex carries the same Fins, so the first that holds any says them;
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

/** As its host listed it (`LiveSummary.children`): an Apex's count before this window holds its roster. */
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

/** A Thread's Fins counted by group: one selector for the rail's badge, the strip's count and the phone's row. */
export function threadRollup(state: AcpState, thread: string | undefined): Rollup {
  const children = threadChildren(state, thread)
  return children.length || !thread ? rollup(children) : (listedRollup(state, thread) ?? rollup(children))
}

const askingOf = new WeakMap<readonly NativeAgent[], readonly NativeAgent[]>()

/**
 * A Thread's Fins that wait on the person, in its roster's order, the same array while its roster is. Empty until this
 * window holds the roster; the Inbox reads the roster of every Apex whose count says one waits (`useInboxRosters`).
 */
export function threadAsking(state: AcpState, thread: string | undefined): readonly NativeAgent[] {
  const children = threadChildren(state, thread)
  let held = askingOf.get(children)
  if (!held) {
    const asking = children.filter((agent) => childGroup(childStateOf(agent)) === "needs")
    held = asking.length ? asking : NO_CHILDREN
    askingOf.set(children, held)
  }
  return held
}

export function useThreadRollup(thread: string | undefined): Rollup {
  return useAcp((state) => threadRollup(state, thread), sameRollup)
}

export function useThreadChildren(thread: string | undefined): readonly NativeAgent[] {
  return useAcp((state) => threadChildren(state, thread))
}

/** What a Thread's Fins ask the person (`personAsks`), the same array while its roster is unchanged. */
export function useThreadAsks(thread: string | undefined): readonly PersonAsk[] {
  const children = useThreadChildren(thread)
  return useMemo(() => personAsks(children), [children])
}

const stoppableOf = new WeakMap<readonly NativeAgent[], readonly NativeAgent[]>()

/** The Fins an Apex's Stop all stops: any a stop can reach, queued and asking included, so none starts after its Apex stops. */
export function stoppableChildren(children: readonly NativeAgent[]): readonly NativeAgent[] {
  let held = stoppableOf.get(children)
  if (!held) {
    held = children.some((child) => child.stoppable) ? children.filter((child) => child.stoppable) : NO_CHILDREN
    stoppableOf.set(children, held)
  }
  return held
}

/** How many of an Apex's Fins work, and how many its Stop all reaches: what the Apex's Stop asks about. */
export interface StopCounts {
  working: number
  reached: number
}

export function stopCounts(children: readonly NativeAgent[]): StopCounts {
  const reached = stoppableChildren(children)
  return { working: reached.filter((child) => childGroup(childStateOf(child)) === "working").length, reached: reached.length }
}

/** The Apex's conversation the person talks to: the one on screen if it's the Apex's, else any of its Sessions with Fins. */
export function apexConversation(state: AcpState, thread: string): AcpConversation | undefined {
  const active = state.activeKey ? state.conversations[state.activeKey] : undefined
  if (active?.threadId === thread) return active
  return Object.values(state.conversations).find((conversation) => conversation.threadId === thread && conversation.kind === "live" && rosterChildren(conversation.nativeAgents).length > 0)
}

/** A Fin's own conversation in this window, when it has one: what opens when its tab is pressed. */
export function childConversation(state: AcpState, child: string): AcpConversation | undefined {
  return Object.values(state.conversations).find((conversation) => conversation.threadId === child)
}

/**
 * A Fin opened inside its Apex's Thread: the Apex's strip stays, with the Fin's tab selected, and the Fin's own
 * transcript and composer are on screen. `shown` turns true once it is, and anything else on screen after that ends
 * it, as opening any other tab or row would.
 */
export interface FinInApex {
  apex: string
  /** The Apex's Thread name, for the breadcrumb and the "From …" card. */
  apexTitle: string
  child: string
  shown: boolean
}

interface ApexViewState {
  open: FinInApex | null
}

export const apexViewStore = createStore<ApexViewState>({ open: null })

export const useApexView = createHook(apexViewStore)

/** Open `child` in place, inside the Apex's Thread: its live conversation, else its saved transcript. */
export function openFinInApex(apex: string, apexTitle: string, child: NativeAgent): void {
  const thread = child.child?.thread
  if (!thread) return
  const state = acpStore.get()
  const conversation = (child.child?.conversation ? state.conversations[child.child.conversation] : undefined) ?? childConversation(state, thread)
  apexViewStore.set({ open: { apex, apexTitle, child: thread, shown: false } })
  if (conversation) {
    acp.activate(conversation.key)
    return
  }
  const saved = threadsStore.get().threads.find((ref) => ref.threadId === thread)
  if (saved) void threads.view(saved, "native")
  else if (child.child?.path && child.child.nativeId)
    void threads.view({ harness: child.provider, nativeId: child.child.nativeId, path: child.child.path, title: child.title, threadId: thread }, "native")
}

/** Back to the Apex: the Session last shown in it. */
export function backToApex(): void {
  const open = apexViewStore.get().open
  apexViewStore.set({ open: null })
  if (!open) return
  const last = threadGroupsStore.get().lastViewed[open.apex]
  const state = acpStore.get()
  const conversation =
    Object.values(state.conversations).find((candidate) => candidate.threadId === open.apex && candidate.sessionId === last) ??
    apexConversation(state, open.apex)
  if (conversation) acp.activate(conversation.key)
}

/** Keeps the Fin view honest: it ends once anything else is on screen. */
export function watchApexView(): () => void {
  const sync = () => {
    const open = apexViewStore.get().open
    if (!open) return
    const here = currentOnScreen().thread
    if (here === open.child) {
      if (!open.shown) apexViewStore.set({ open: { ...open, shown: true } })
    } else if (open.shown && here !== undefined) apexViewStore.set({ open: null })
  }
  const stops = [acpStore.subscribe(sync), threadsStore.subscribe(sync), apexViewStore.subscribe(sync)]
  return () => stops.forEach((stop) => stop())
}

/**
 * The name of the Apex a transcript's Thread answers to, for the "From …" card over its brief: the Apex it's open
 * in, else its edge's parent as this window lists it. Undefined when this window lists no Apex for it.
 */
export function useApexTitle(liveId: string | undefined, threadPath: string | undefined): string | undefined {
  const apex = useAcp((state) => (liveId ? state.conversations[liveId]?.parent?.thread : undefined))
  const savedApex = useThreads((state) => (threadPath && !apex ? state.threads.find((ref) => ref.path === threadPath)?.parent?.thread : undefined))
  const thread = apex ?? savedApex
  const opened = useApexView((state) => (thread && state.open?.apex === thread ? state.open.apexTitle : undefined))
  const listed = useThreads((state) => (thread ? state.threads.find((ref) => ref.threadId === thread)?.title : undefined))
  const live = useAcp((state) => (thread ? Object.values(state.conversations).find((conversation) => conversation.threadId === thread)?.title : undefined))
  return opened ?? listed ?? live
}

/** The harness the Apex of a Fin's Thread runs on, from what this window holds of it, for its avatar. */
export function useApexHarness(liveId: string | undefined, threadPath: string | undefined): string | undefined {
  const apex = useAcp((state) => (liveId ? state.conversations[liveId]?.parent?.thread : undefined))
  const savedApex = useThreads((state) => (threadPath && !apex ? state.threads.find((ref) => ref.path === threadPath)?.parent?.thread : undefined))
  const thread = apex ?? savedApex
  const live = useAcp((state) => (thread ? Object.values(state.conversations).find((conversation) => conversation.threadId === thread)?.harness : undefined))
  const listed = useThreads((state) => (thread && !live ? state.threads.find((ref) => ref.threadId === thread)?.harness : undefined))
  return live ?? listed
}

/**
 * Moves a message the Apex passed on to one of its Fins to another, as
 * the person's own words there (`mako:agents-redirect`). Undefined when it
 * couldn't, the person told why.
 */
export async function redirectRouted(apex: string, input: AgentsRedirectInput): Promise<AgentsRedirected | undefined> {
  if (!hasBridge()) return undefined
  try {
    const answer = await getMako().agentsRedirect(apex, input)
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

/** The Fin an Apex's composer writes to next, straight, with no turn of the Apex's: as `@` or a routing line's Reply chose it. */
export interface Addressee {
  /** The Fin's Thread. */
  fin: string
  name: string
  title: string
  provider: string
}

interface AddresseeState {
  /** By the Apex's conversation key; a message sent or taken back clears it, so the next one goes to the Apex again. */
  to: Readonly<Record<string, Addressee>>
}

export const addresseeStore = createStore<AddresseeState>({ to: {} })

export const useAddressee = createHook(addresseeStore)

/** A stopped Fin's delegation is over: nothing is sent or moved to it. */
export function finStopped(agent: NativeAgent): boolean {
  const state = childStateOf(agent)
  return state.kind === "ended" && state.outcome === "stopped"
}

/** A Fin as the composer names it; undefined for a stopped one, or one from a host that can't take a message for it (no `child.name`). */
export function addresseeOf(agent: NativeAgent): Addressee | undefined {
  const child = agent.child
  if (!child?.name || finStopped(agent)) return undefined
  return { fin: child.thread, name: child.name, title: agent.title, provider: agent.provider }
}

/** The Fins an Apex's composer can write to, in the roster's order. */
export function addressableFins(children: readonly NativeAgent[]): Addressee[] {
  return children.flatMap((agent) => {
    const addressee = addresseeOf(agent)
    return addressee ? [addressee] : []
  })
}

/** What the `@` menu's row for a Fin hands its pick: never inserted, it addresses the message (`pickedFin`). */
export function finPick(fin: string): string {
  return `${FIN_PICK}${fin}`
}
const FIN_PICK = "@mako-fin:"

export function pickedFin(value: string): string | undefined {
  return value.startsWith(FIN_PICK) ? value.slice(FIN_PICK.length) : undefined
}

export function address(conversation: string, addressee: Addressee): void {
  addresseeStore.set((state) => ({ to: { ...state.to, [conversation]: addressee } }))
}

export function unaddress(conversation: string): void {
  if (!addresseeStore.get().to[conversation]) return
  addresseeStore.set((state) => ({ to: Object.fromEntries(Object.entries(state.to).filter(([key]) => key !== conversation)) }))
}

/**
 * Sends the person's message from the Apex's conversation straight to one
 * of its Fins (`mako:agents-direct`): no turn of the Apex's runs, and its
 * transcript draws the routing line. `request` is the composer's id for the
 * message, so a retry delivers it once. Undefined when it couldn't, the
 * person told why.
 */
export async function sendDirect(conversation: string, addressee: Addressee, request: string, text: string, attachments: PromptAttachment[]): Promise<AgentsDirected | undefined> {
  if (!hasBridge()) return undefined
  try {
    const answer = await getMako().agentsDirect(conversation, { to: addressee.fin, request, text, ...(attachments.length && { attachments }) })
    if ("refused" in answer) {
      toast.error(`Your message didn't reach ${addressee.name}`, { description: answer.why })
      return undefined
    }
    unaddress(conversation)
    return answer
  } catch (error) {
    toast.error(`Your message didn't reach ${addressee.name}`, { description: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}
