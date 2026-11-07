import { windowRoutesStore } from "@/state/window-routes"
import { childGroup, childStateOf, finsAsChildren, rollup, rosterChildren, sameRollup, type Rollup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { entryState, type AgentsDirected, type AgentsRedirected, type AgentsRedirectInput, type ChildState } from "@mako/host/contracts/agents"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { useMemo } from "react"
import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import { personAsks, type PersonAsk } from "@/state/fin-asks"
import { acp, acpStore, useAcp, type AcpState } from "@/state/acp"
import type { AcpConversation, LiveAcpConversation } from "@/state/acp-state"
import type { ThreadRef } from "@/lib/types"
import { createHook, createStore } from "@/state/store"
import { currentOnScreen } from "@/state/thread-sessions"
import { threads } from "@/state/threads"
import { threadsStore, useThreads } from "@/state/thread-store"
import { threadGroupsStore } from "@/state/thread-groups"

const NO_CHILDREN: readonly NativeAgent[] = []
const byThread = new WeakMap<AcpState["conversations"], { order: AcpState["threadSessions"]; index: Map<string, readonly NativeAgent[]> }>()
const listedByThread = new WeakMap<AcpState["conversations"], { order: AcpState["threadSessions"]; index: Map<string, Rollup> }>()
const finByThread = new WeakMap<AcpState["conversations"], { order: AcpState["threadSessions"]; index: Map<string, FinSource> }>()

/** What a conversation says of a Thread's Fins: which Thread, from which of its Sessions (none for a word from outside it), and how fully. */
type Saying<Value> = { thread: string; session: string | undefined; value: Value; fullness: number }

/**
 * Of each Thread's conversations that say something of its Fins (`said`, with how fully, higher the fuller), the
 * newest Session's: the last of its Thread's Sessions in the store's order (`AcpState.threadSessions`) that this window
 * holds, and of one Session the fullest. A Fin's start, end or change of state reaches every Session of its Apex, and
 * its progress only the newest (`progressReaders`), so every surface takes its Fins by this one rule, from a roster this
 * window holds or a row the account lists alike. A Thread with no group has one Session. A conversation may say of
 * several Threads' Fins (an Apex's roster says of each Fin; a Fin's own row on another device says of itself), so each
 * saying names its Thread and the Session it comes from, and a word from outside that Thread ranks below any Session of it.
 */
function newestSaid<Value>(state: AcpState, said: (conversation: Extract<AcpConversation, { kind: "live" }>) => readonly Saying<Value>[]): Map<string, Value> {
  const index = new Map<string, Value>()
  const rank = new Map<string, number>()
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.kind !== "live" || !conversation.threadId) continue
    for (const saying of said(conversation)) {
      const sessions = state.threadSessions?.[saying.thread]
      const place = sessions && saying.session ? sessions.indexOf(saying.session) : -1
      const standing = place * 2 + saying.fullness
      if (index.has(saying.thread) && standing <= rank.get(saying.thread)!) continue
      index.set(saying.thread, saying.value)
      rank.set(saying.thread, standing)
    }
  }
  return index
}

/** Where a placed Fin's standing comes from: its Apex's word of it, or the row its own device writes, listed here. */
type FinSource = { kind: "apex" } | { kind: "device"; listed: LiveAcpConversation }

/**
 * Where each Fin placed on another device stands from, by the one ranking (`newestSaid`) over every source that says
 * of it: its Apex's word, a word from outside the Fin's Thread, and the rows that Fin's own device writes, each from
 * one of the Fin's Sessions there. So the newest Session on its device wins, whichever its rows were listed in, and an
 * older idle Session never hides a newer one's approval; a quiet device's row still names what opens, while its
 * standing is its Apex's word (`placedEntry`).
 */
function finSources(state: AcpState): Map<string, FinSource> {
  let held = finByThread.get(state.conversations)
  if (!held || held.order !== state.threadSessions) {
    const index = newestSaid<FinSource>(state, (conversation) => {
      if (conversation.elsewhere !== undefined) return [{ thread: conversation.threadId!, session: conversation.sessionId, value: { kind: "device", listed: conversation }, fullness: 1 }]
      const children = rosterChildren(conversation.nativeAgents)
      return (children.length ? children : conversation.fins ? finsAsChildren(conversation.fins) : [])
        .filter((agent) => agent.child?.thread && !agent.child.conversation)
        .map((agent) => ({ thread: agent.child!.thread, session: undefined, value: { kind: "apex" }, fullness: 0 }))
    })
    held = { order: state.threadSessions, index }
    finByThread.set(state.conversations, held)
  }
  return held.index
}

/**
 * A Thread's Fins, as its conversations' rosters carry them (`childEntry`, never a harness's roster), in
 * `orderedChildren`' order, or as the account lists them where this window holds no roster of that Session (another
 * device's, or one asleep), from its newest Session (`newestSaid`). The array is the roster's own while that roster is
 * unchanged, so a row reading it repaints only when they change.
 */
export function threadChildren(state: AcpState, thread: string | undefined): readonly NativeAgent[] {
  if (!thread) return NO_CHILDREN
  let held = byThread.get(state.conversations)
  if (!held || held.order !== state.threadSessions) {
    const index = newestSaid(state, (conversation) => {
      const children = rosterChildren(conversation.nativeAgents)
      if (children.length) return [{ thread: conversation.threadId!, session: conversation.sessionId, value: children, fullness: 1 }]
      return conversation.fins ? [{ thread: conversation.threadId!, session: conversation.sessionId, value: finsAsChildren(conversation.fins), fullness: 0 }] : []
    })
    const sources = finSources(state)
    for (const [apex, children] of index) index.set(apex, fromSources(children, sources))
    held = { order: state.threadSessions, index }
    byThread.set(state.conversations, held)
  }
  return held.index.get(thread) ?? NO_CHILDREN
}

/** A roster with each Fin on another device as its winning source says it (`finSources`): the same array while every source is its Apex's. */
function fromSources(children: readonly NativeAgent[], sources: Map<string, FinSource>): readonly NativeAgent[] {
  let over: NativeAgent[] | undefined
  children.forEach((agent, index) => {
    const thread = agent.child?.thread
    if (!thread || agent.child?.conversation) return
    const source = sources.get(thread)
    if (source?.kind !== "device") return
    over ??= [...children]
    over[index] = placedEntry(agent, source.listed)
  })
  return over ?? children
}

/** The entry with the Fin's own conversation and, while its device is heard, how it stands there (`placedState`). */
function placedEntry(agent: NativeAgent, listed: LiveAcpConversation): NativeAgent {
  const state = listed.quietSince === undefined ? placedState(agent.child?.state, listed) : agent.child?.state
  return { ...agent, ...(state && { state: entryState(state) }), child: { ...agent.child!, conversation: listed.key, ...(state && { state }) } }
}

/** How a placed Fin stands, from the row its device writes: what it waits on, at work, failed, or as its Apex last said. */
function placedState(said: ChildState | undefined, listed: LiveAcpConversation): ChildState | undefined {
  if (listed.waitingOn) return { kind: "blocked", question: listed.waitingOn, on: listed.waitingFor === "approval" ? "approval" : "person" }
  const status = listed.session.status
  if (status === "running" || status === "starting") return said?.kind === "working" ? said : { kind: "working" }
  if (status === "failed") return { kind: "ended", outcome: "failed" }
  if (said?.kind === "ended" || said?.kind === "idle" || said?.kind === "queued") return said
  return status === "ready" ? { kind: "idle" } : said
}

/**
 * What opens for a Fin's row: its live conversation in this window (its own device's, or listed from the device it
 * runs on), else its saved transcript here. Undefined for one this window can't open, a Fin on a device whose row
 * isn't listed: its row draws as not openable, and nothing sets a view with nothing behind it.
 */
export type FinOpening = { kind: "conversation"; key: string } | { kind: "saved"; ref: ThreadRef } | { kind: "native"; ref: ThreadRef }

export function finOpening(state: AcpState, child: NativeAgent): FinOpening | undefined {
  const thread = child.child?.thread
  if (!thread) return undefined
  // Its conversation as its row names it; else, for a Fin on another device, that device's newest listed Session
  // (`finSources`, the one ranking every roster reads); else any conversation of its Thread held here.
  const source = finSources(state).get(thread)
  const conversation = (child.child?.conversation ? state.conversations[child.child.conversation] : undefined) ?? (source?.kind === "device" ? source.listed : undefined) ?? childConversation(state, thread)
  if (conversation) return { kind: "conversation", key: conversation.key }
  const saved = threadsStore.get().threads.find((ref) => ref.threadId === thread)
  if (saved) return { kind: "saved", ref: saved }
  if (child.child?.path && child.child.nativeId) return { kind: "native", ref: { harness: child.provider, nativeId: child.child.nativeId, path: child.child.path, title: child.title, threadId: thread } }
  return undefined
}

/** Whether a Fin's row opens anything here (`finOpening`), for the row to draw itself by. */
export function useFinOpenable(child: NativeAgent): boolean {
  return useAcp((state) => finOpening(state, child) !== undefined)
}

/** As its host listed it (`LiveSummary.children`): an Apex's count before this window holds its roster, its newest Session's. */
function listedRollup(state: AcpState, thread: string): Rollup | undefined {
  let held = listedByThread.get(state.conversations)
  if (!held || held.order !== state.threadSessions) {
    held = { order: state.threadSessions, index: newestSaid(state, (conversation) => (conversation.children ? [{ thread: conversation.threadId!, session: conversation.sessionId, value: conversation.children, fullness: 0 }] : [])) }
    listedByThread.set(state.conversations, held)
  }
  return held.index.get(thread)
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
  const { routes } = windowRoutesStore.get()
  if (routes?.fin) return routes.fin(apex, child)
  const thread = child.child?.thread
  if (!thread) return
  // What will open is found first: a row with nothing behind it opens nothing, and sets no view.
  const state = acpStore.get()
  const opening = finOpening(state, child)
  if (!opening) return
  apexViewStore.set({ open: { apex, apexTitle, child: thread, shown: false } })
  if (opening.kind === "conversation") acp.activate(opening.key)
  else void threads.view(opening.ref, "native")
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

/** Keeps the Fin view honest: it ends once anything else is on screen, a saved conversation with no Thread of its own too. */
export function watchApexView(): () => void {
  const sync = () => {
    const open = apexViewStore.get().open
    if (!open) return
    const here = currentOnScreen().thread
    if (here === open.child) {
      if (!open.shown) apexViewStore.set({ open: { ...open, shown: true } })
    } else if (open.shown && (here !== undefined || threadsStore.get().viewing)) apexViewStore.set({ open: null })
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

/** A Fin as the composer names it, a stopped one too, which a message resumes; undefined for one from a host that can't take a message for it (no `child.name`). */
export function addresseeOf(agent: NativeAgent): Addressee | undefined {
  const child = agent.child
  if (!child?.name) return undefined
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
