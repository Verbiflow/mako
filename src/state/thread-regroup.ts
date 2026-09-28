import { toast } from "sonner"
import type { ThreadGroup, ThreadRegroup } from "../../electron/contracts/thread-groups.ts"
import type { ThreadRef } from "@/lib/types"
import { getMako } from "@/lib/bridge"
import { harnessLabel } from "@/lib/harness-label"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { selectAcpPresence, type AcpPresence } from "@/state/acp-presence"
import { acpStore } from "@/state/acp-state"
import { threadsStore } from "@/state/threads"
import { appendRecoveredDraft, draftText, draftsStore, rememberDraft } from "@/state/drafts"
import { createHook, createStore } from "@/state/store"
import {
  applyThreadRegroup,
  discardSessionDraft,
  putSessionDraft,
  rowThread,
  sessionDraftKey,
  threadGroupsStore,
} from "@/state/thread-groups"
import { archivedLive, archivedThread, nativeThreadTarget, threadLifecycle, type ThreadTarget } from "@/state/thread-lifecycle"
import { prefsStore } from "@/state/prefs"
import { currentOnScreen, currentThreadTabs, openSessionTab, sessionTabTitle, type SessionTab } from "@/state/thread-sessions"

/** What "Add to thread…" acts on: a whole Thread from its row, or one Session from its tab. */
export interface AddToThreadRequest {
  sessions: string[]
  from: string
  /** How the picker names what is being added. */
  title: string
  cwd?: string
}

export const addToThreadStore = createStore<{ request: AddToThreadRequest | null }>({ request: null })
export const useAddToThread = createHook(addToThreadStore)

export function openAddToThread(request: AddToThreadRequest): void {
  addToThreadStore.set({ request })
}

export function closeAddToThread(): void {
  addToThreadStore.set({ request: null })
}

/** What "Add existing session…" adds to: the Thread whose `+` or palette opened it. */
export interface AddSessionRequest {
  thread: string
  /** How the picker names the Thread being added to. */
  title: string
  cwd?: string
}

export const addSessionStore = createStore<{ request: AddSessionRequest | null }>({ request: null })
export const useAddSession = createHook(addSessionStore)

export function openAddSession(request: AddSessionRequest): void {
  addSessionStore.set({ request })
}

export function closeAddSession(): void {
  addSessionStore.set({ request: null })
}

/** Open "Add existing session…" for the Thread on screen, named as its rail row is. */
export function openAddSessionHere(): boolean {
  const here = currentOnScreen()
  if (!here.thread) return false
  const first = currentThreadTabs(here.thread).find((tab) => tab.kind === "session")
  const title = first ? sessionTabTitle(first, prefsStore.get().titleOverrides) : here.title ?? "this thread"
  openAddSession({ thread: here.thread, title, cwd: here.cwd })
  return true
}

/**
 * What archiving a Thread with several Sessions acts on: every Session with
 * a row in the catalog or a live conversation, found in the whole list, not
 * the rows a filter or search left showing.
 */
export function wholeThreadTargets(thread: string): ThreadTarget[] | undefined {
  const group = threadGroupsStore.get().groups[thread]
  if (!group) return undefined
  const refs = threadsStore.get().threads
  const live = selectAcpPresence(acpStore.get())
  const targets = new Map<string, ThreadTarget>()
  for (const member of group.sessions) {
    const ref = refs.find((entry) => entry.sessionId === member.id)
    const presence = ref ? undefined : live.find((entry) => entry.sessionId === member.id)
    const target: ThreadTarget | undefined = ref ? nativeThreadTarget(ref) : presence && { kind: "live", id: presence.key }
    if (target) targets.set(JSON.stringify(target), target)
  }
  return targets.size ? [...targets.values()] : undefined
}

/** A row stands for its whole Thread, archived Sessions included, so a Thread stays whole. */
export function rowSessions(thread: string | undefined, session: string | undefined): string[] {
  const group = thread ? threadGroupsStore.get().groups[thread] : undefined
  return group ? group.sessions.map((member) => member.id) : session ? [session] : []
}

/**
 * A Thread emptied by a join keeps its unsent new tab: it becomes the new
 * tab of the Thread it joined, with its text where it was, unless that
 * Thread has one already, which then takes the text.
 */
function carryDraft(from: string, to: string): "moved" | "merged" | null {
  const { drafts, open } = threadGroupsStore.get()
  const draft = drafts[from]
  if (!draft) return null
  discardSessionDraft(from)
  const existing = drafts[to]
  const key = sessionDraftKey(draft) ?? ""
  if (!existing) {
    putSessionDraft({ ...draft, thread: to, key }, open === from)
    return "moved"
  }
  const text = draftText(key)
  const plans = draftsStore.get().drafts.find((entry) => entry.key === key)?.plans
  if (!text && !plans?.length) return null
  appendRecoveredDraft(sessionDraftKey(existing) ?? "", { id: crypto.randomUUID(), key, text, attachments: [], plans })
  rememberDraft(key, "")
  return "merged"
}

/**
 * Run a regroup under a fresh operation ID, which its Undo names. A refusal
 * is shown under `failed` and the Sessions stay where they were.
 */
async function regroup(work: (operationId: string) => Promise<ThreadRegroup>, failed: string): Promise<string | null> {
  const operationId = crypto.randomUUID()
  try {
    applyThreadRegroup(await work(operationId))
    return operationId
  } catch (error) {
    toast.error(failed, { description: error instanceof Error ? error.message : String(error) })
    return null
  }
}

const join = (sessions: readonly string[], thread: string) => (id: string) => getMako().threadJoin(id, [...sessions], thread)
const split = (sessions: readonly string[]) => (id: string) => getMako().threadSplit(id, [...sessions])

/**
 * The last regroup or Session archive in this window, still undoable after
 * its toast is gone: from the command palette, until it's undone or another
 * change takes its place. The store keeps a regroup's layouts for a day, and
 * refuses an undo once the Threads it touched changed again.
 */
let lastUndo: { label: string; run: () => Promise<void> } | null = null

export function hasThreadUndo(): boolean {
  return lastUndo !== null
}

export function threadUndoLabel(): string | undefined {
  return lastUndo?.label
}

export async function undoLastThreadChange(): Promise<void> {
  const undo = lastUndo
  lastUndo = null
  if (undo) await undo.run()
}

function offerUndo(label: string, run: () => Promise<void>, description?: string): void {
  const entry = { label, run }
  lastUndo = entry
  toast(label, {
    description,
    duration: ACTION_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => {
        if (lastUndo === entry) lastUndo = null
        void run()
      },
    },
  })
}

/** Every Session goes back to the Thread and position it had; a carried draft goes back with its Thread. */
async function undoRegroup(operation: string, draft?: { from: string; to: string }): Promise<void> {
  if (!(await regroup((id) => getMako().threadRegroupUndo(id, operation), "Couldn't undo"))) return
  if (draft) carryDraft(draft.from, draft.to)
}

/** Add Sessions to another Thread; they become its last tabs. */
export async function addToThread(request: AddToThreadRequest, target: { thread: string; title: string }): Promise<boolean> {
  const source = threadGroupsStore.get().groups[request.from]
  const emptied = !source || source.sessions.every((member) => request.sessions.includes(member.id))
  const operation = await regroup(join(request.sessions, target.thread), `Couldn't add to “${target.title}”`)
  if (!operation) return false
  const carried = emptied ? carryDraft(request.from, target.thread) : null
  const draft = carried === "moved" ? { from: target.thread, to: request.from } : undefined
  offerUndo(`Added to “${target.title}”`, () => undoRegroup(operation, draft))
  return true
}

/** Split Sessions into a new Thread of their own. */
export async function splitIntoNewThread(sessions: readonly string[]): Promise<boolean> {
  const operation = await regroup(split(sessions), "Couldn't split into a new thread")
  if (!operation) return false
  offerUndo("Split into a new thread", () => undoRegroup(operation))
  return true
}

function tabTarget(tab: Extract<SessionTab, { kind: "session" }>): ThreadTarget | null {
  if (tab.ref) return nativeThreadTarget(tab.ref)
  return tab.presence ? { kind: "live", id: tab.presence.key } : null
}

/**
 * Archive one Session of a Thread from its tab. Its run keeps going. The
 * Thread's other tabs stay, and the one on screen hands over to its
 * neighbour first.
 */
export async function archiveSessionTab(tab: Extract<SessionTab, { kind: "session" }>, thread: string): Promise<boolean> {
  const target = tabTarget(tab)
  if (!target) return false
  const here = currentOnScreen()
  if (here.session === tab.id) {
    const sessions = currentThreadTabs(thread).filter((candidate) => candidate.kind === "session")
    const at = sessions.findIndex((candidate) => candidate.id === tab.id)
    const neighbour = sessions[at + 1] ?? sessions[at - 1]
    if (neighbour) openSessionTab(neighbour)
  }
  if (!(await threadLifecycle.archive([target], true, false))) return false
  const running = tab.presence?.status === "running" || tab.presence?.status === "starting"
  offerUndo("Session archived", async () => { await threadLifecycle.archive([target], false, false) }, running ? "Its run keeps going." : undefined)
  return true
}

/** A Thread "Add to thread…" can pick. */
export interface ThreadChoice {
  thread: string
  title: string
  cwd?: string
  /** Each Session's agent, in tab order. */
  harnesses: string[]
  sessions: number
  updatedAt: number
}

/**
 * Every other Thread with something on screen in the rail, newest first,
 * the Threads of the same project before the rest. A Thread is named by
 * the first Session in its tab order that has a row.
 */
export function threadChoices(input: {
  refs: readonly ThreadRef[]
  presences: readonly AcpPresence[]
  groups: Readonly<Record<string, ThreadGroup>>
  threadOf: Readonly<Record<string, string>>
  archived: ReadonlySet<string>
  overrides: Readonly<Record<string, string>>
  exclude: string
  cwd?: string
}): ThreadChoice[] {
  const { groups, threadOf, archived, overrides, exclude } = input
  interface Row { thread: string; rank: number; harness: string; cwd?: string; title: string; updatedAt: number }
  const rows: Row[] = []
  const seen = new Set<string>()
  const take = (row: { threadId?: string; sessionId?: string; harness: string; cwd?: string }, title: string, updatedAt: number) => {
    const thread = rowThread(row, threadOf)
    if (!thread || thread === exclude) return
    const index = groups[thread]?.sessions.findIndex((member) => member.id === row.sessionId) ?? -1
    rows.push({ thread, rank: index < 0 ? Number.MAX_SAFE_INTEGER : index, harness: row.harness, cwd: row.cwd, title, updatedAt })
  }
  for (const ref of input.refs) {
    if (!ref.sessionId || seen.has(ref.sessionId) || archivedThread(ref, archived)) continue
    seen.add(ref.sessionId)
    take(ref, overrides[ref.path] ?? ref.title ?? "Untitled session", ref.updatedAt ? Date.parse(ref.updatedAt) || 0 : 0)
  }
  for (const presence of input.presences) {
    if (!presence.sessionId || seen.has(presence.sessionId) || archivedLive(presence, archived)) continue
    seen.add(presence.sessionId)
    const title = (presence.threadPath ? overrides[presence.threadPath] : undefined) ?? presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
    take(presence, title, presence.createdAt)
  }
  // In tab order, so a Thread is named by its first Session and shows its agents as the rail does.
  rows.sort((left, right) => left.rank - right.rank)
  const byThread = new Map<string, ThreadChoice>()
  for (const row of rows) {
    const found = byThread.get(row.thread)
    if (!found) {
      byThread.set(row.thread, { thread: row.thread, title: row.title, cwd: row.cwd, harnesses: [row.harness], sessions: 1, updatedAt: row.updatedAt })
      continue
    }
    found.sessions += 1
    found.updatedAt = Math.max(found.updatedAt, row.updatedAt)
    found.harnesses.push(row.harness)
  }
  const near = (choice: ThreadChoice) => (input.cwd && choice.cwd === input.cwd ? 0 : 1)
  return [...byThread.values()].sort((left, right) => near(left) - near(right) || right.updatedAt - left.updatedAt)
}

/** A Session "Add existing session…" can pick, with the Thread it would leave. */
export interface SessionChoice {
  session: string
  thread: string
  harness: string
  title: string
  cwd?: string
  updatedAt: number
  /** The Thread it leaves, named as the rail names it, when that Thread keeps other Sessions. */
  leaves?: { title: string; sessions: number }
}

/**
 * Every Session outside `into` with something on screen in the rail, one
 * choice each, newest first, the same project before the rest.
 */
export function sessionChoices(input: {
  refs: readonly ThreadRef[]
  presences: readonly AcpPresence[]
  groups: Readonly<Record<string, ThreadGroup>>
  threadOf: Readonly<Record<string, string>>
  archived: ReadonlySet<string>
  overrides: Readonly<Record<string, string>>
  into: string
  cwd?: string
}): SessionChoice[] {
  const { threadOf, archived, overrides, into } = input
  const threads = new Map(threadChoices({ ...input, exclude: into, cwd: undefined }).map((choice) => [choice.thread, choice]))
  const choices: SessionChoice[] = []
  const seen = new Set<string>()
  const take = (row: { threadId?: string; sessionId?: string; harness: string; cwd?: string }, title: string, updatedAt: number) => {
    const thread = rowThread(row, threadOf)
    const from = thread ? threads.get(thread) : undefined
    if (!thread || !from || !row.sessionId) return
    const leaves = from.sessions > 1 ? { title: from.title, sessions: from.sessions - 1 } : undefined
    choices.push({ session: row.sessionId, thread, harness: row.harness, title, cwd: row.cwd, updatedAt, leaves })
  }
  for (const ref of input.refs) {
    if (!ref.sessionId || seen.has(ref.sessionId) || archivedThread(ref, archived)) continue
    seen.add(ref.sessionId)
    take(ref, overrides[ref.path] ?? ref.title ?? "Untitled session", ref.updatedAt ? Date.parse(ref.updatedAt) || 0 : 0)
  }
  for (const presence of input.presences) {
    if (!presence.sessionId || seen.has(presence.sessionId) || archivedLive(presence, archived)) continue
    seen.add(presence.sessionId)
    const title = (presence.threadPath ? overrides[presence.threadPath] : undefined) ?? presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
    take(presence, title, presence.createdAt)
  }
  const near = (choice: SessionChoice) => (input.cwd && choice.cwd === input.cwd ? 0 : 1)
  return choices.sort((left, right) => near(left) - near(right) || right.updatedAt - left.updatedAt)
}
