import { useEffect, useRef, useSyncExternalStore } from "react"
import { finsWord } from "@mako/host/contracts/agents"
import { askWords } from "@mako/host/contracts/children"
import { agentAskLine, type AgentAsk } from "@mako/host/contracts/agent-asks"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import type { LivePermissionRequest, ThreadRef } from "@/lib/types"
import { workspaceName } from "@/lib/format"
import { acp } from "@/state/acp"
import { selectAcpPresence } from "@/state/acp-presence"
import { acpStore, type AcpConversation, type AcpState, type LiveAcpConversation } from "@/state/acp-state"
import { openFinInApex, threadChildren } from "@/state/apex-fins"
import { answerLiveApproval } from "@/state/live-approvals"
import { hydrateLive } from "@/state/live-recovery"
import { threads } from "@/state/threads"
import { openConversation, windowRoutesStore } from "@/state/window-routes"
import { personAsks, type PersonAsk } from "@/state/fin-asks"
import { inboxView } from "@/state/inbox-view"
import type { ThreadsState } from "@/state/thread-state"
import { threadStatus } from "@/state/thread-status"
import { threadsStore } from "@/state/thread-store"
import { threadTitle } from "@/state/thread-titles"
import { allAsks, setupAskWords, setupStore } from "@/state/setup"
import { openAppSetup } from "@/state/app-setup"
import type { SetupAsk } from "@mako/host/contracts/setup"

export { inboxView, inboxViewStore, useInboxView } from "@/state/inbox-view"

/**
 * The Inbox: everything waiting on the person, across every Thread and Fin,
 * read from the records the marks read (a live conversation's approval, a Fin
 * blocked on the person in its Apex's roster, a Thread's attention), never a
 * list of its own. Answering an item is the same call the Agents panel, the
 * dock and the Thread make, so the answer leaves every surface at once.
 *
 * Built for the hot path: each conversation's and each roster's items are
 * kept by the identity of the record they come from, so a token streaming in
 * one Thread recomputes in a few lookups and hands back the same items, and a
 * reader comparing them repaints nothing.
 */

/** Where an Apex's Fin sits, for the crumb "Mobile polish › Sheet motion on iPad". */
export interface InboxApex {
  thread: string
  title: string
  /** The Apex's conversation in this window, whose host hears its Fins' answers. */
  conversation: string
}

/** A Fin asking the person, from its Apex's roster (`personAsks`). */
export interface FinInboxItem {
  kind: "fin"
  key: string
  title: string
  harness: string
  question: string
  since: number
  apex: InboxApex
  ask: PersonAsk
  agent: NativeAgent
}

/** A Thread's own approval or question, held by its live conversation here. */
export interface ApprovalInboxItem {
  kind: "approval"
  key: string
  title: string
  harness: string
  question: string
  since: number
  conversation: string
  permission: LivePermissionRequest
  /** Answerable from a button: not a question form, a sign-in, or an ask whose process has gone. */
  answerable: boolean
  apex?: Omit<InboxApex, "conversation">
}

/** Something waits on the person that only its Thread can answer: another device's, another app's, a sign-out. */
export interface WaitingInboxItem {
  kind: "waiting"
  key: string
  title: string
  harness: string
  question: string
  since: number
  open: InboxTarget
}

/** What a Thread's agent asked through Mako's tools (`AgentAsk`), kept in its conversation and answered as its card is. */
export interface AgentAskInboxItem {
  kind: "agent-ask"
  key: string
  title: string
  harness: string
  question: string
  since: number
  conversation: string
  ask: AgentAsk
}

/** An agent's ask for something its place lacks, from the project's Setup (`setup.ts`), answered the same as there. */
export interface SetupInboxItem {
  kind: "setup"
  key: string
  title: string
  harness: string
  question: string
  since: number
  folder: string
  ask: SetupAsk
  /** Its page was built away from its Mac (`SetupView.away`): only a no can be said here. */
  away: boolean
}

export type InboxAsk = FinInboxItem | ApprovalInboxItem | AgentAskInboxItem | WaitingInboxItem | SetupInboxItem

/** An answer not yet read, or a failure: opening its Thread is reading it. */
export interface ReadInboxItem {
  kind: "review" | "failed"
  key: string
  title: string
  harness: string
  detail?: string
  at: number
  open: InboxTarget
}

export type InboxTarget = { kind: "conversation"; key: string } | { kind: "ref"; ref: ThreadRef }

export interface InboxModel {
  asks: readonly InboxAsk[]
  toRead: readonly ReadInboxItem[]
}

/** "To read" is news, not an archive: the newest this many. */
export const TO_READ_LIMIT = 40

const NONE: readonly never[] = []

function liveTitle(conversation: AcpConversation): string {
  return threadTitle(conversation.threadId) ?? conversation.threadTitle ?? conversation.title ?? (conversation.kind === "live" ? conversation.session.title : undefined) ?? workspaceName(conversation.cwd)
}

function refTitle(ref: ThreadRef): string {
  return threadTitle(ref.threadId) ?? ref.title ?? workspaceName(ref.cwd)
}

const approvals = new WeakMap<LivePermissionRequest, ApprovalInboxItem>()
const agentAskItems = new WeakMap<AgentAsk, AgentAskInboxItem>()

function agentAskItem(conversation: LiveAcpConversation, ask: AgentAsk): AgentAskInboxItem {
  const held = agentAskItems.get(ask)
  const title = liveTitle(conversation)
  if (held?.title === title) return held
  const item: AgentAskInboxItem = { kind: "agent-ask", key: `agent-ask:${conversation.key}:${ask.id}`, title, harness: conversation.harness, question: agentAskLine(ask.want), since: ask.at, conversation: conversation.key, ask }
  agentAskItems.set(ask, item)
  return item
}

function approvalOf(conversation: LiveAcpConversation, permission: LivePermissionRequest, apex: ApprovalInboxItem["apex"]): ApprovalInboxItem {
  const held = approvals.get(permission)
  if (held && held.apex?.thread === apex?.thread) return held
  const item: ApprovalInboxItem = {
    kind: "approval",
    key: `approval:${conversation.key}:${permission.id}`,
    title: liveTitle(conversation),
    harness: conversation.harness,
    question: permission.title,
    since: conversation.updatedAt,
    conversation: conversation.key,
    permission,
    answerable: !permission.questions && !permission.gone && permission.kind !== "authentication" && permission.options.length > 0,
    ...(apex && { apex }),
  }
  approvals.set(permission, item)
  return item
}

const finItems = new WeakMap<readonly NativeAgent[], { apex: InboxApex; items: readonly FinInboxItem[] }>()

function finItemsOf(children: readonly NativeAgent[], apex: InboxApex): readonly FinInboxItem[] {
  const held = finItems.get(children)
  if (held && held.apex.conversation === apex.conversation && held.apex.title === apex.title) return held.items
  const byFin = new Map(children.map((agent) => [agent.child?.thread, agent]))
  const items = personAsks(children).map((ask): FinInboxItem => {
    const agent = byFin.get(ask.fin)!
    return {
      kind: "fin",
      key: `fin:${ask.fin}:${ask.ask.id}`,
      title: ask.title,
      harness: ask.harness,
      question: askWords(ask),
      since: agent.observedAt ?? agent.startedAt ?? 0,
      apex,
      ask,
      agent,
    }
  })
  finItems.set(children, { apex, items })
  return items
}

/** The path → ref index of a catalog, built once per catalog. */
const refIndexes = new WeakMap<readonly ThreadRef[], Map<string, ThreadRef>>()

function refsByPath(refs: readonly ThreadRef[]): Map<string, ThreadRef> {
  let index = refIndexes.get(refs)
  if (!index) {
    index = new Map(refs.map((ref) => [ref.path, ref]))
    refIndexes.set(refs, index)
  }
  return index
}

type Inputs = [AcpState["conversations"], ThreadRef[], ThreadsState["attention"], ThreadsState["externalActivity"], ThreadsState["working"], SetupStateOf["byFolder"]]
type SetupStateOf = ReturnType<typeof setupStore.get>
let last: { inputs: Inputs; model: InboxModel } | null = null

/** What waits on the person and what's to read, the same object while none of what it reads has changed. */
export function inboxModel(acp: AcpState = acpStore.get(), threads: ThreadsState = threadsStore.get(), setup: SetupStateOf = setupStore.get()): InboxModel {
  const inputs: Inputs = [acp.conversations, threads.threads, threads.attention, threads.externalActivity, threads.working, setup.byFolder]
  if (last && last.inputs.every((input, index) => input === inputs[index])) return last.model
  const model = buildModel(acp, threads, setup)
  const previous = last?.model
  // Unchanged items keep the last model, so a reader comparing it by identity never repaints for a token.
  const kept = previous && sameItems(previous.asks, model.asks) && sameItems(previous.toRead, model.toRead) ? previous : model
  last = { inputs, model: kept }
  return kept
}

function buildModel(acp: AcpState, threads: ThreadsState, setup: SetupStateOf): InboxModel {
  const conversations = Object.values(acp.conversations)
  const asks: InboxAsk[] = []
  // Threads whose asks are said here already: an Apex's by its Fins, a conversation's by its approval.
  const coveredPaths = new Set<string>()
  const askingFins = new Set<string>()
  const apexes = new Set<string>()
  // Apexes said by their count alone, their own approval or wait said by that item too.
  const unread = new Set<string>()
  for (const conversation of conversations) {
    if (conversation.kind !== "live" || !conversation.threadId || apexes.has(conversation.threadId)) continue
    const children = threadChildren(acp, conversation.threadId)
    if (!children.length) {
      // An Apex whose roster this window doesn't hold yet says only how many of its Fins need the person; the roster
      // is being read (`useInboxRosters`), and its asks take this item's place when it lands.
      const needs = conversation.children?.needs ?? 0
      if (!needs) continue
      apexes.add(conversation.threadId)
      unread.add(conversation.key)
      asks.push({ kind: "waiting", key: `apex:${conversation.key}`, title: liveTitle(conversation), harness: conversation.harness, question: `${finsWord(needs)} ${needs === 1 ? "needs" : "need"} you`, since: conversation.updatedAt, open: { kind: "conversation", key: conversation.key } })
      if (conversation.threadPath) coveredPaths.add(conversation.threadPath)
      continue
    }
    apexes.add(conversation.threadId)
    const items = finItemsOf(children, { thread: conversation.threadId, title: liveTitle(conversation), conversation: conversation.key })
    for (const item of items) askingFins.add(item.ask.fin)
    asks.push(...items)
    if (items.length && conversation.threadPath) coveredPaths.add(conversation.threadPath)
  }
  // What an agent asked is its conversation's own, beside its Fins' asks and whatever else it waits on. A Fin's goes
  // through its Apex first, as its harness's approvals do, and is listed from the Apex's roster once it's the person's.
  for (const conversation of conversations) {
    if (conversation.kind !== "live" || conversation.parent || conversation.session.connection !== "connected") continue
    for (const ask of conversation.control?.asks ?? []) asks.push(agentAskItem(conversation, ask))
    if (conversation.control?.asks?.length && conversation.threadPath) coveredPaths.add(conversation.threadPath)
  }
  const apexTitle = (thread: string) => {
    const apex = conversations.find((conversation) => conversation.threadId === thread && conversation.kind === "live")
    return apex ? liveTitle(apex) : threadTitle(thread) ?? "Apex"
  }
  for (const conversation of conversations) {
    if (conversation.kind !== "live" || unread.has(conversation.key)) continue
    if (conversation.threadId && askingFins.has(conversation.threadId)) {
      if (conversation.threadPath) coveredPaths.add(conversation.threadPath)
      continue
    }
    const apex = conversation.parent ? { thread: conversation.parent.thread, title: apexTitle(conversation.parent.thread) } : undefined
    if (conversation.session.connection === "connected" && conversation.permission) {
      asks.push(approvalOf(conversation, conversation.permission, apex))
      if (conversation.threadPath) coveredPaths.add(conversation.threadPath)
    } else if (conversation.session.connection !== "connected" && conversation.waitingOn) {
      asks.push({ kind: "waiting", key: `waiting:${conversation.key}`, title: liveTitle(conversation), harness: conversation.harness, question: conversation.waitingOn, since: conversation.updatedAt, open: { kind: "conversation", key: conversation.key } })
      if (conversation.threadPath) coveredPaths.add(conversation.threadPath)
    }
  }
  // What a Thread's record says waits on the person, when no live conversation here holds the ask itself.
  const index = refsByPath(threads.threads)
  const waitingPaths = new Set<string>()
  for (const [path, attention] of Object.entries(threads.attention)) if (attention.kind === "needs-permission") waitingPaths.add(path)
  for (const [path, external] of Object.entries(threads.externalActivity)) if (external.status === "needs-input") waitingPaths.add(path)
  for (const path of waitingPaths) {
    const ref = index.get(path)
    if (!ref || ref.parent || coveredPaths.has(path)) continue
    const status = threadStatus(ref, threads)
    if (status.kind !== "needs-permission") continue
    asks.push({ kind: "waiting", key: `waiting:${path}`, title: refTitle(ref), harness: ref.harness, question: status.detail ?? "Waiting for you", since: status.since, open: { kind: "ref", ref } })
  }
  for (const { folder, ask } of allAsks(setup))
    asks.push({ kind: "setup", key: `setup:${ask.id}`, title: ask.by.title, harness: ask.by.harness ?? "", question: setupAskWords(ask), since: ask.at, folder, ask, away: Boolean(setup.byFolder[folder]?.away) })
  asks.sort((left, right) => left.since - right.since)

  const toRead: ReadInboxItem[] = []
  for (const [path, attention] of Object.entries(threads.attention)) {
    if (attention.kind === "needs-permission" || (attention.kind === "review" && !attention.unread)) continue
    const ref = index.get(path)
    if (!ref || ref.parent) continue
    const status = threadStatus(ref, threads)
    if (status.kind !== attention.kind) continue
    toRead.push({ kind: attention.kind, key: `read:${path}`, title: refTitle(ref), harness: ref.harness, at: attention.at, ...(attention.kind === "failed" && attention.detail && { detail: attention.detail }), open: { kind: "ref", ref } })
  }
  toRead.sort((left, right) => right.at - left.at)
  return { asks: asks.length ? asks : NONE, toRead: toRead.length ? toRead.slice(0, TO_READ_LIMIT) : NONE }
}

function sameItem(left: InboxAsk | ReadInboxItem, right: InboxAsk | ReadInboxItem): boolean {
  if (left === right) return true
  if (left.key !== right.key || left.kind !== right.kind || left.title !== right.title) return false
  if (left.kind === "fin") return right.kind === "fin" && left.ask === right.ask && left.since === right.since && left.apex.title === right.apex.title
  if (left.kind === "approval") return right.kind === "approval" && left.permission === right.permission
  if (left.kind === "agent-ask") return right.kind === "agent-ask" && left.ask === right.ask
  if (left.kind === "waiting") return right.kind === "waiting" && left.question === right.question && left.since === right.since
  if (left.kind === "setup") return right.kind === "setup" && left.ask === right.ask
  return (right.kind === "review" || right.kind === "failed") && left.at === right.at && left.detail === right.detail
}

export function sameItems<Item extends InboxAsk | ReadInboxItem>(left: readonly Item[], right: readonly Item[]): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => sameItem(item, right[index]!)))
}

/** How many things wait on the person: the Inbox row's count, the phone's chip. */
export function inboxCount(model: InboxModel): number {
  return model.asks.length
}

function subscribe(listener: () => void): () => void {
  const offAcp = acpStore.subscribe(listener)
  const offThreads = threadsStore.subscribe(listener)
  const offSetup = setupStore.subscribe(listener)
  return () => {
    offAcp()
    offThreads()
    offSetup()
  }
}

/**
 * A slice of the Inbox, re-read on every change of the two stores it comes
 * from and handed back the same while `isEqual` says it's unchanged: the
 * Inbox row's count is a number, so a token never repaints the row.
 */
export function useInbox<S>(select: (model: InboxModel) => S, isEqual: (left: S, right: S) => boolean = Object.is): S {
  const held = useRef<{ model: InboxModel; value: S } | null>(null)
  const read = () => {
    const model = inboxModel()
    const current = held.current
    if (current?.model === model) return current.value
    const value = select(model)
    if (current && isEqual(current.value, value)) {
      current.model = model
      return current.value
    }
    held.current = { model, value }
    return value
  }
  return useSyncExternalStore(subscribe, read, read)
}

export function useInboxCount(): number {
  return useInbox(inboxCount)
}

const rostersAsked = new Set<string>()

/** The conversations of the Apexes the Inbox knows only by their count, one line each, the same string while they are. */
function unreadRosters(model: InboxModel): string {
  return model.asks.flatMap((item) => (item.kind === "waiting" && item.key.startsWith("apex:") && item.open.kind === "conversation" ? [item.open.key] : [])).join("\n")
}

/**
 * Reads the roster of every Apex whose Fins need the person but whose roster this window doesn't hold, once each, so
 * the Inbox shows and answers their asks without the Apex being opened first. Mounted with the Inbox's row.
 */
export function useInboxRosters(): void {
  const pending = useInbox(unreadRosters)
  useEffect(() => {
    for (const key of pending ? pending.split("\n") : []) {
      if (rostersAsked.has(key)) continue
      rostersAsked.add(key)
      void hydrateLive(key, true)
    }
  }, [pending])
}

/** Opens an item's Thread, or the Fin inside its Apex, and leaves the Inbox for it. */
export function openInboxItem(item: InboxAsk | ReadInboxItem): void {
  inboxView.close()
  const { routes } = windowRoutesStore.get()
  const conversation = (key: string) => {
    const presence = routes ? selectAcpPresence(acpStore.get()).find((entry) => entry.key === key) : undefined
    if (presence) openConversation(presence)
    else acp.open(key)
  }
  if (item.kind === "setup") {
    openAppSetup(setupStore.get().byFolder[item.folder]?.root ?? item.folder, "setup")
    return
  }
  if (item.kind === "fin") {
    if (routes) conversation(item.apex.conversation)
    else openFinInApex(item.apex.thread, item.apex.title, item.agent)
    return
  }
  const target = item.kind === "approval" || item.kind === "agent-ask" ? ({ kind: "conversation", key: item.conversation } as const) : item.open
  if (target.kind === "conversation") conversation(target.key)
  else void threads.view(target.ref)
}

/** Answers a Thread's approval with one of its options, as its own card would; false when it didn't land. */
export function answerApproval(item: ApprovalInboxItem, optionId: string): Promise<boolean> {
  return answerLiveApproval(item.conversation, item.permission.id, { kind: "choice", optionId })
}
