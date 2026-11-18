import type { PendingPrompt } from "@/state/prompt-delivery"
import type { ComposerTarget } from "@/state/composer-settings"
import type { LiveSnapshot, LiveStartOptions, LiveSummary, ThreadRef } from "@/lib/types"
import type { LiveProjection } from "@/state/live-projection"
import type { Entry } from "@mako/sessions/entries"
import { asks as waitsOnThePerson, type WaitingFor } from "@mako/protocol/attention"
import type { ThreadPurposeKind } from "@mako/host/contracts/thread-purposes"
import type { CloudStartStep } from "@mako/host/contracts/cloud-threads"
import type { ListedContinueChoice } from "@mako/host/contracts/live-conversations"
import type { WorktreeStep } from "@mako/host/contracts/thread-worktrees"
import type { ReleasedTurn } from "@/state/transcript-residency"
import type {
  LivePermissionRequest,
  PromptAttachment,
  LiveSessionState,
} from "@/lib/types"
import { createEntryHook, createHook, createStore, keyedSubscriptions } from "@/state/store"
import { backgroundWork, type BackgroundWork } from "@mako/host/contracts/background-work"
import { entryState, type ChildState } from "@mako/host/contracts/agents"
import { finsAsChildren, rosterChildren, type Rollup } from "@mako/host/contracts/children"
import { withChildren, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"

export interface AcpQueuedPrompt {
  text: string
  attachments: PromptAttachment[]
}

interface AcpConversationBase {
  hasSessionQuestions?: boolean
  history?: LiveSnapshot["history"]
  releasedTurns?: ReleasedTurn[]
  /**
   * The native session the next reply goes on in: the one a start bound, or
   * an earlier one chosen by replying from its own history. A send names it,
   * so a retry lands where the person chose. It lapses once the conversation
   * moves to another binding (`withLiveReplyTarget`).
   */
  replyBindingId?: string
  pendingPrompts?: PendingPrompt[]
  nativeAgents?: LiveSnapshot["nativeAgents"]
  goal?: LiveSnapshot["goal"]
  side?: LiveSnapshot["side"]
  /** The wait its agent armed, as the person's waiting line reads it (`TurnWaitLine`). */
  turnWait?: LiveSnapshot["turnWait"]
  key: string
  draftKey: string
  harness: string
  cwd: string
  title?: string
  nativePaths?: string[]
  threadPath?: string
  /** Where its folder is when it isn't on this Mac, in words (`a cloud machine`): its files and Git are read there. */
  elsewhere?: string
  /** `LiveSummary.elsewhereKind`: the kind of device `elsewhere` names, for its mark. */
  elsewhereKind?: string
  /** `LiveSummary.order`: its Session's place in its Thread as its owner keeps it, which ranks a Thread's rows this window holds no group of. */
  order?: number
  /** What a conversation listed from another device waits on there, while it waits on a person ("Approve: npm test"). */
  waitingOn?: string
  /** What it waits on the person for, as its owner says it (`LiveSummary.waitingFor`): an approval, a question, or anything else. */
  waitingFor?: WaitingFor
  /** Its Thread's name as the device it runs on has it, for a conversation listed from another device. */
  threadTitle?: string
  /** Listed from a device the account hasn't heard from since then: none of it at work, and the rail says when it was last seen. */
  quietSince?: number
  /** `LiveSummary.cloudContinue`: whether a quiet device's Thread may continue in the cloud from here, and the continue the account carries of it. */
  cloudContinue?: ListedContinueChoice
  /** `LiveSummary.movedAt`: when a conversation listed from another device last moved, as the account's list says. */
  movedAt?: number
  /** `LiveSummary.rail`: what its owner's rail shows of a conversation listed from another device. */
  rail?: LiveSnapshot["rail"]
  /** `LiveSummary.promptedAt`: when the person last sent it a message, kept current by the requests and steers its batches carry. */
  promptedAt?: number
  /** Read from the copy its device keeps in the account, that device being off: when the device wrote it. */
  copy?: { at: number }
  /** The Thread-store Thread and Session, from the host; a `+` tab's start knows them before it does. */
  threadId?: string
  sessionId?: string
  /** `LiveSummary.parent`: the Thread this one is a child of, which shows it; never a row of its own. */
  parent?: LiveSnapshot["parent"]
  /** `LiveSummary.children`: an Apex's Fins counted, until its roster arrives. */
  children?: LiveSnapshot["children"]
  /** `LiveSummary.fins`: an Apex's Fins as another device's row lists them, while this window holds no roster of it. */
  fins?: LiveSummary["fins"]
  control?: LiveSnapshot["control"]
  requests?: LiveSnapshot["requests"]
  harnessTurns?: LiveSnapshot["harnessTurns"]
  spentThrough?: LiveSnapshot["spentThrough"]
  base?: LiveSnapshot["base"]
  /** While `base` is null on a hydrated conversation, the host is reading it from this session. */
  baseSource?: LiveSnapshot["baseSource"]
  historyFailure?: string
  baseCoveredBlocks?: number
  revision?: number
  /** The host generation that numbered `revision`; a batch from another epoch is never merged onto this state. */
  epoch?: string
  /** `LiveSnapshot.activityAt`, on the host's clock. */
  activityAt?: number
  /** `LiveSnapshot.nativeActivity`; `since` is on the host's clock. */
  nativeActivity?: LiveSnapshot["nativeActivity"]
  hydrated?: boolean
  projection?: LiveProjection
  /**
   * The projection it last had, while it isn't shown and its batches go undrawn: the next one starts from it
   * (`projectAcp`), so opening it draws what those batches changed and every turn before them is the object it was.
   */
  behind?: LiveProjection
  blocks: Entry[]
  /**
   * What the host said its next batch will add to the last block (`LiveAhead`), drawn until that batch lands
   * (`shownBlocks`). It counts only while `revision` is the one it names; `blocks` never holds it, so every batch and
   * snapshot is read against what the host's journal holds.
   */
  ahead?: { revision: number; more: string }
  queued: AcpQueuedPrompt[]
  hiddenUserPrompt: string | null
  createdAt: number
  updatedAt: number
}

export interface StartingAcpConversation extends AcpConversationBase {
  unconfirmedStart?: LiveStartOptions
  settingsTarget: ComposerTarget
  kind: "starting"
  /** A new Thread starting in its own worktree, and whether the host has checked it out yet. */
  worktree?: "making" | "made"
  /** What making it is doing now, once the host says. */
  worktreeStep?: WorktreeStep
  /** A cloud Thread's start, once the host says: its project coming up, then its harness starting. */
  cloudStep?: { step: CloudStartStep; project: string }
  /** What Mako starts this Thread for; its row shows it until the host's record of the Thread arrives. */
  purpose?: ThreadPurposeKind
}

export interface LiveAcpConversation extends AcpConversationBase {
  kind: "live"
  session: LiveSessionState
  permission: LivePermissionRequest | null
  sending: boolean
  canceling: boolean
  /**
   * The current failure has been opened. A session that failed before it had
   * a store has no thread path to carry attention, so its rail row reads the
   * session's status directly; this is how that row stands down once seen.
   * Cleared whenever the status leaves `failed`, so the next failure is new.
   */
  failureSeen?: boolean
}

/** What `failureSeen` becomes when a conversation takes a new session state. */
export function carriedFailureSeen(
  previous: { failureSeen?: boolean } | undefined,
  session: Pick<LiveSessionState, "status">
): boolean | undefined {
  return session.status === "failed" ? previous?.failureSeen : undefined
}

export type AcpConversation = StartingAcpConversation | LiveAcpConversation

export interface AcpState {
  activeKey: string | null
  conversations: Record<string, AcpConversation>
  /**
   * Each Thread of several Sessions, its Sessions in its store's order (`ThreadGroup.sessions`), as `thread-groups.ts`
   * keeps them: the last is the newest, whose Fins every surface draws (`threadChildren`).
   */
  threadSessions?: Readonly<Record<string, readonly string[]>>
}

export const acpStore = createStore<AcpState>({
  activeKey: null,
  conversations: {},
})

// Selection belongs to this window, including raw browser/dev reloads that
// bypass the Reload UI command. Persist only changes, never token updates.
let rememberedSelection: string | null = null
acpStore.subscribe(() => {
  const selected = acpStore.get().activeKey
  if (selected === rememberedSelection) return
  rememberedSelection = selected
  try {
    globalThis.sessionStorage?.setItem("mako:reload-conversation", selected ?? "new")
  } catch {
    // Storage denial must not prevent switching conversations.
  }
})

export const useAcp = createHook(acpStore)

/**
 * One conversation as its transcript's rows read it: `selector` is given the conversation `key` names and runs when
 * that conversation changes. A batch of any other conversation runs none of them, where a selector on `useAcp` runs
 * for every row of every mounted transcript on every batch in the window.
 */
export const acpConversations = keyedSubscriptions(acpStore, (state) => state.conversations)
export const useAcpConversation = createEntryHook(acpConversations)

type LiveRequest = NonNullable<LiveSnapshot["requests"]>[number]
const requestsById = new WeakMap<readonly LiveRequest[], Map<string, LiveRequest>>()

/**
 * The conversation's request `id`, from a map made once for its requests as they stand: they're a new array whenever
 * one changes. Each turn's rows looked theirs up by walking the array, on every batch.
 */
export function requestOf(conversation: Pick<AcpConversation, "requests"> | null | undefined, id: string | undefined): LiveRequest | undefined {
  const requests = conversation?.requests
  if (!requests || id === undefined) return undefined
  let byId = requestsById.get(requests)
  if (!byId) {
    byId = new Map()
    // The first of an id is the one a walk of the array found.
    for (const request of requests) if (!byId.has(request.id)) byId.set(request.id, request)
    requestsById.set(requests, byId)
  }
  return byId.get(id)
}

/**
 * The live store as the rail reads it: the same state, said to its readers only when a fact a row shows moved (a
 * conversation listed or gone, its status, title, place or Fins; the one on screen; a Thread's Sessions). A streamed
 * batch moves none of them, so it runs no row's selector. What streams (`STREAMED`, and a session's `usage`) stands
 * here as of the last such change: a reader of any of it takes `useAcp`.
 */
export const railAcpStore = createStore<AcpState>(acpStore.get())
export const useRailAcp = createHook(railAcpStore)

type Conversations = AcpState["conversations"]

/**
 * What a batch changes of a conversation that no rail row reads. `session` is read field by field (`SESSION_STREAMED`),
 * and `updatedAt` only ranks two conversations that stand for one row (`overtakes`).
 */
const STREAMED: ReadonlySet<string> = new Set<keyof LiveAcpConversation>([
  "session", "blocks", "projection", "behind", "revision", "epoch", "updatedAt", "activityAt", "nativeActivity", "history",
  "releasedTurns", "base", "baseSource", "baseCoveredBlocks", "harnessTurns", "spentThrough", "turnWait", "goal", "side",
  "historyFailure", "queued", "pendingPrompts", "hiddenUserPrompt", "replyBindingId", "sending", "canceling", "ahead",
])
/** What a session says that no rail row reads: its context reading moves through a turn. */
const SESSION_STREAMED: ReadonlySet<string> = new Set<keyof LiveSessionState>(["usage"])

/** The fields a conversation or its session holds, as its type names them. */
function fieldsOf<Value extends LiveAcpConversation | StartingAcpConversation | LiveSessionState>(value: Value): (keyof Value & string)[] {
  // SAFETY: conversations and sessions are built only from their typed values, so every own key is one of their fields.
  return Object.keys(value) as (keyof Value & string)[]
}

function fieldsMoved<Value extends LiveAcpConversation | StartingAcpConversation | LiveSessionState>(before: Value, after: Value, unread: ReadonlySet<string>): boolean {
  for (const key of fieldsOf(after)) if (!unread.has(key) && !Object.is(before[key], after[key])) return true
  for (const key of fieldsOf(before)) if (!unread.has(key) && !(key in after) && before[key] !== undefined) return true
  return false
}

/** Whether `after` differs from `before` in anything a rail row could show: any field but the streamed ones. */
function railFactsMoved(before: AcpConversation, after: AcpConversation): boolean {
  if (before.kind === "starting") return after.kind !== "starting" || fieldsMoved(before, after, STREAMED)
  if (after.kind !== "live" || fieldsMoved(before, after, STREAMED)) return true
  return before.session !== after.session && fieldsMoved(before.session, after.session, SESSION_STREAMED)
}

/** The newest conversations object that shows the rail nothing `railAcpStore` doesn't already hold. */
let quiet: Conversations | null = null

acpStore.subscribe(() => {
  const state = acpStore.get()
  const shown = railAcpStore.get()
  if (
    (state.conversations === shown.conversations || state.conversations === quiet) &&
    state.activeKey === shown.activeKey &&
    state.threadSessions === shown.threadSessions
  )
    return
  quiet = null
  railAcpStore.set(state)
})

/** What's kept by the conversations object it was derived from, and how it follows a change that leaves it true. */
const derived: { carry: (before: Conversations, after: Conversations) => void; drop: (conversations: Conversations) => void }[] = []

function carried<Value extends object>(cache: WeakMap<Conversations, Value>, before: Conversations, after: Conversations): void {
  const held = cache.get(before)
  if (held) cache.set(after, held)
}

/**
 * `derive` over the whole state, kept while no conversation's rail facts move and the Threads' Sessions stand: a
 * streamed batch reads it back, where it once built it again. `last` is what it derived before, for a derivation
 * that keeps the identity of what didn't change.
 */
export function railDerived<Value>(derive: (state: AcpState, last: Value | undefined) => Value): (state: AcpState) => Value {
  const held = new WeakMap<Conversations, { order: AcpState["threadSessions"]; value: Value }>()
  let last: Value | undefined
  derived.push({ carry: (before, after) => carried(held, before, after), drop: (conversations) => held.delete(conversations) })
  return (state) => {
    let entry = held.get(state.conversations)
    if (!entry || entry.order !== state.threadSessions) {
      last = derive(state, last)
      entry = { order: state.threadSessions, value: last }
      held.set(state.conversations, entry)
    }
    return entry.value
  }
}

export function activeAcp(state: AcpState): AcpConversation | null {
  return state.activeKey ? (state.conversations[state.activeKey] ?? null) : null
}

export function activeLiveAcp(state: AcpState): LiveAcpConversation | null {
  const active = activeAcp(state)
  return active?.kind === "live" ? active : null
}

const threadIndexes = new WeakMap<Conversations, Map<string, Set<string>>>()

function lookupKeys(conversation: AcpConversation): string[] {
  const keys = new Set<string>()
  for (const path of [
    conversation.threadPath,
    ...(conversation.nativePaths ?? []),
  ])
    if (path) keys.add(JSON.stringify(["path", path]))
  if (conversation.kind === "live" && conversation.session.nativeId)
    keys.add(
      JSON.stringify([
        "native",
        conversation.session.harness,
        conversation.session.nativeId,
      ])
    )
  for (const binding of conversation.control?.bindings ?? []) {
    if (binding.path) keys.add(JSON.stringify(["path", binding.path]))
    if (binding.nativeId)
      keys.add(JSON.stringify(["native", binding.provider, binding.nativeId]))
  }
  return [...keys]
}

function threadIndex(conversations: AcpState["conversations"]) {
  const held = threadIndexes.get(conversations)
  if (held) return held
  const index = new Map<string, Set<string>>()
  for (const [id, conversation] of Object.entries(conversations))
    for (const key of lookupKeys(conversation)) {
      const matches = index.get(key) ?? new Set<string>()
      matches.add(id)
      index.set(key, matches)
    }
  threadIndexes.set(conversations, index)
  return index
}

function carryThreadIndex(
  before: Conversations,
  after: Conversations,
  id: string,
  oldKeys: readonly string[],
  newKeys: readonly string[]
): void {
  const held = threadIndexes.get(before)
  if (!held) return
  if (
    oldKeys.length === newKeys.length &&
    oldKeys.every((key, index) => key === newKeys[index])
  ) {
    threadIndexes.set(after, held)
    return
  }
  const next = new Map(held)
  for (const key of new Set([...oldKeys, ...newKeys])) {
    const matches = new Set(held.get(key))
    matches.delete(id)
    if (newKeys.includes(key)) matches.add(id)
    if (matches.size) next.set(key, matches)
    else next.delete(key)
  }
  threadIndexes.set(after, next)
}

export function acpForThread(
  state: AcpState,
  ref: ThreadRef | { path: string }
): AcpConversation | null {
  const { path } = ref
  const identity = "nativeId" in ref ? ref : undefined
  const index = threadIndex(state.conversations)
  const candidates = new Set([
    ...(index.get(JSON.stringify(["path", path])) ?? []),
    ...(identity
      ? (index.get(
          JSON.stringify(["native", identity.harness, identity.nativeId])
        ) ?? [])
      : []),
  ])
  const ordered =
    candidates.size > 1
      ? Object.keys(state.conversations).filter((id) => candidates.has(id))
      : candidates
  let found: AcpConversation | null = null
  for (const id of ordered) {
    const conversation = state.conversations[id]
    if (!conversation) continue
    const available =
      conversation.kind === "starting" ||
      conversation.session.status !== "closed" ||
      Boolean(conversation.control?.questions?.length || (!conversation.hydrated && conversation.hasSessionQuestions))
    const ownsIdentity =
      identity &&
      conversation.kind === "live" &&
      conversation.session.harness === identity.harness &&
      conversation.session.nativeId === identity.nativeId
    if (
      available &&
      (ownsIdentity ||
        ((!identity || conversation.harness === identity.harness) &&
          conversation.threadPath === path) ||
        // Its stores' paths, without their providers: the bindings below say whose each is once they're known.
        (!(identity && conversation.control) && conversation.nativePaths?.includes(path)) ||
        conversation.control?.bindings.some(
          (binding) =>
            (!identity || binding.provider === identity.harness) &&
            (binding.path === path ||
              (identity && binding.nativeId === identity.nativeId))
        )) &&
      (!found || conversation.updatedAt > found.updatedAt)
    )
      found = conversation
  }
  return found
}

const NO_CHILDREN: readonly NativeAgent[] = []
// The three indexes below are of what the conversations say of their Threads' Fins (`sayings`): each is kept by the
// conversations object it was built from, and follows a change that says nothing new (`replaceAcpConversation`).
const finByThread = new WeakMap<Conversations, { order: AcpState["threadSessions"]; index: Map<string, FinSource> }>()
const byThread = new WeakMap<Conversations, { order: AcpState["threadSessions"]; index: Map<string, readonly NativeAgent[]> }>()
const listedByThread = new WeakMap<Conversations, { order: AcpState["threadSessions"]; index: Map<string, Rollup> }>()

const NOTHING_SAID: readonly unknown[] = []

/**
 * Everything the indexes read of one conversation (`finSources`, `threadChildren`, `listedCounts`, and `placedEntry`
 * of a row listed from elsewhere): while these stand, the indexes built with it do.
 */
function sayings(conversation: AcpConversation | undefined): readonly unknown[] {
  if (conversation?.kind !== "live" || !conversation.threadId) return NOTHING_SAID
  const own = [conversation.threadId, conversation.sessionId, conversation.order, rosterChildren(conversation.nativeAgents), conversation.fins, conversation.children, conversation.elsewhere !== undefined]
  return conversation.elsewhere === undefined ? own : [...own, conversation.key, conversation.waitingFor, conversation.waitingOn, conversation.quietSince, conversation.session.status]
}

function saysTheSame(before: AcpConversation | undefined, after: AcpConversation | undefined): boolean {
  const left = sayings(before)
  const right = sayings(after)
  return left.length === right.length && left.every((value, index) => value === right[index])
}

derived.push(
  { carry: () => {}, drop: (conversations) => threadIndexes.delete(conversations) },
  { carry: () => {}, drop: (conversations) => { finByThread.delete(conversations); byThread.delete(conversations); listedByThread.delete(conversations) } }
)

/**
 * What a conversation says of a Thread's Fins: which Thread, from which of its Sessions (none for a word from outside
 * it), that Session's place in its Thread as its owner's row says it (`order`, from a row listed from elsewhere), how
 * fully, and whether it asks the person something open (approval, question or needs-you), which no other saying
 * of the Thread may hide.
 */
type Saying<Value> = { thread: string; session: string | undefined; order: number | undefined; value: Value; fullness: number; asks?: boolean }

/** A saying's standing for its Thread: an open ask above all, then the Session's place, then fullness (`outranks`). */
type Standing = { asks: boolean; place: number; fullness: number }

/**
 * Whether `next` outranks `held`: an open ask always surfaces, as the host's `askingConversation` does,
 * both by the protocol's `asks`, then the Session's place in its
 * Thread, newest highest, then of one Session the fullest saying.
 */
function outranks(next: Standing, held: Standing): boolean {
  if (next.asks !== held.asks) return next.asks
  if (next.place !== held.place) return next.place > held.place
  return next.fullness > held.fullness
}

/**
 * Of each Thread's conversations that say something of its Fins (`said`, with how fully, higher the fuller), the
 * newest Session's: the last of its Thread's Sessions in the store's order (`AcpState.threadSessions`) that this window
 * holds, and of one Session the fullest. A Fin's moves, its progress and its start, end or change of state alike, reach
 * only its Apex's newest Session (`finReaders`), so every surface takes its Fins by this one rule, from a roster this
 * window holds or a row the account lists alike, as what a Session waits on does (`conversationWork`). A Thread with no
 * group has one Session. These are copies of the Fins, current only in the newest, so an ask in an older copy isn't
 * ranked first: it's one answered since. An ask a Session makes itself always surfaces where it's read: a Fin's
 * standing is read from whichever of its Sessions waits on the person (`askingConversation` on its host), and a ranking
 * of a Session's own standing ranks one with an open ask above one without, then by this order. Each saying names
 * its Thread and Session: an Apex may say of a placed Fin whose Thread is elsewhere. Without a local group, its
 * owner's reported `order` ranks the Sessions; older hosts without it keep arrival order.
 */
export function newestSaid<Value>(state: AcpState, said: (conversation: Extract<AcpConversation, { kind: "live" }>) => readonly Saying<Value>[]): Map<string, Value> {
  const index = new Map<string, Value>()
  const rank = new Map<string, Standing>()
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.kind !== "live" || !conversation.threadId) continue
    for (const saying of said(conversation)) {
      const sessions = state.threadSessions?.[saying.thread]
      const inGroup = sessions && saying.session ? sessions.indexOf(saying.session) : -1
      const standing: Standing = { asks: saying.asks ?? false, place: inGroup >= 0 ? inGroup : (saying.order ?? -1), fullness: saying.fullness }
      const held = rank.get(saying.thread)
      if (held && !outranks(standing, held)) continue
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
 * one of the Fin's Sessions there, at the place that device keeps it (`order`). A row with an open ask surfaces above
 * the rest, as `askingConversation` does on the host, then the newest Session on its device wins, whichever order
 * its rows were listed in; a quiet device's row still names what opens, while its
 * standing is its Apex's word (`placedEntry`).
 */
export function finSources(state: AcpState): Map<string, FinSource> {
  let held = finByThread.get(state.conversations)
  if (!held || held.order !== state.threadSessions) {
    const index = newestSaid<FinSource>(state, (conversation) => {
      // A row with an open ask surfaces above the Fin's other rows: what waits on the person by the protocol's one word
      // (`asks`: an approval, a question, or needs-you, the owner's fallback for any other wait on them).
      if (conversation.elsewhere !== undefined) return [{ thread: conversation.threadId!, session: conversation.sessionId, order: conversation.order, value: { kind: "device", listed: conversation }, fullness: 1, asks: conversation.waitingFor !== undefined && waitsOnThePerson(conversation.waitingFor) }]
      const children = rosterChildren(conversation.nativeAgents)
      return (children.length ? children : conversation.fins ? finsAsChildren(conversation.fins) : [])
        .filter((agent) => agent.child?.thread && !agent.child.conversation)
        .map((agent) => ({ thread: agent.child!.thread, session: undefined, order: undefined, value: { kind: "apex" }, fullness: 0 }))
    })
    held = { order: state.threadSessions, index }
    finByThread.set(state.conversations, held)
  }
  return held.index
}

/** Each Thread's Fins counted, as its host listed them (`LiveSummary.children`), by its newest Session (`newestSaid`). */
export function listedCounts(state: AcpState): Map<string, Rollup> {
  let held = listedByThread.get(state.conversations)
  if (!held || held.order !== state.threadSessions) {
    held = { order: state.threadSessions, index: newestSaid(state, (conversation) => (conversation.children ? [{ thread: conversation.threadId!, session: conversation.sessionId, order: conversation.order, value: conversation.children, fullness: 0 }] : [])) }
    listedByThread.set(state.conversations, held)
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
      if (children.length) return [{ thread: conversation.threadId!, session: conversation.sessionId, order: conversation.order, value: children, fullness: 1 }]
      return conversation.fins ? [{ thread: conversation.threadId!, session: conversation.sessionId, order: conversation.order, value: finsAsChildren(conversation.fins), fullness: 0 }] : []
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
 * The conversation's roster with its Thread's Fins as every surface draws them (`threadChildren`): its own provider's
 * work, and its Thread's Fins from its newest Session. Only that Session hears them move (`finReaders`): an older one's
 * own roster keeps them as they stood when it last heard, and read from there its Fins would wait on work long ended or
 * on a question long answered, and miss a new one. Whatever a window says of a Session's Fins reads them here.
 */
export function conversationRoster(state: AcpState, conversation: Pick<LiveAcpConversation, "threadId" | "nativeAgents">): NativeAgentRoster | undefined {
  if (!conversation.threadId) return conversation.nativeAgents
  const children = threadChildren(state, conversation.threadId)
  const own = conversation.nativeAgents
  // `withChildren` makes a roster whenever the own one files its children in another order than the Thread's, as an
  // unopened Apex's does: made once for the pair, every reader sorts and reads that one roster's children once.
  if (!own) {
    if (!withoutRoster.has(children)) withoutRoster.set(children, withChildren(undefined, children))
    return withoutRoster.get(children)
  }
  let held = withRoster.get(own)
  if (!held || held.children !== children) {
    held = { children, roster: withChildren(own, children) }
    withRoster.set(own, held)
  }
  return held.roster
}

const withRoster = new WeakMap<NativeAgentRoster, { children: readonly NativeAgent[]; roster: NativeAgentRoster | undefined }>()
const withoutRoster = new WeakMap<readonly NativeAgent[], NativeAgentRoster | undefined>()

/** What the conversation waits on between turns (`backgroundWork`), its Thread's Fins as they stand (`conversationRoster`). */
export function conversationWork(state: AcpState, conversation: LiveAcpConversation): BackgroundWork | null {
  return backgroundWork(conversation.session, conversationRoster(state, conversation))
}

export function liveAcpForThread(
  state: AcpState,
  path: string
): LiveAcpConversation | null {
  const conversation = acpForThread(state, { path })
  return conversation?.kind === "live" ? conversation : null
}

export function liveAcpConversations(state: AcpState): LiveAcpConversation[] {
  return Object.values(state.conversations).filter(
    (conversation): conversation is LiveAcpConversation =>
      conversation.kind === "live" && conversation.session.status !== "closed"
  )
}

/** `next` without a reply target the conversation has since moved away from. */
function withLiveReplyTarget(previous: AcpConversation | undefined, next: AcpConversation): AcpConversation {
  const target = next.replyBindingId
  const active = next.control?.activeBindingId
  if (!target || !active) return next
  const carried = previous?.replyBindingId === target
  const moved = carried && previous.control?.activeBindingId !== undefined && previous.control.activeBindingId !== active
  return moved ? { ...next, replyBindingId: undefined } : next
}

/**
 * Whether `next` in `previous`'s place changes which conversation a row reads: of two that stand for one row the one
 * that moved last does (`acpForThread`), and this one wasn't already it.
 */
function overtakes(conversations: Conversations, id: string, previous: AcpConversation, next: AcpConversation, keys: readonly string[]): boolean {
  if (next.updatedAt === previous.updatedAt) return false
  const index = threadIndex(conversations)
  for (const key of keys) {
    const matches = index.get(key)
    if (!matches || matches.size < 2) continue
    if (next.updatedAt < previous.updatedAt) return true
    for (const other of matches) if (other !== id && (conversations[other]?.updatedAt ?? 0) >= previous.updatedAt) return true
  }
  return false
}

/** The conversations object a list being taken in builds (`admitAcpConversations`): no listener has seen it, so it's written in place. */
let admitting: Conversations | null = null
let admits = 0

/**
 * Takes in a list as one change: `run` replaces each conversation the list names, the next state is built once, and
 * the store says it once when `run` ends. A boot or a reconnect of 300 conversations was 300 sets, each copying the
 * map and running every selector in the window.
 */
export function admitAcpConversations(run: () => void): void {
  acpStore.batch(() => {
    admits += 1
    try {
      run()
    } finally {
      admits -= 1
      if (!admits) admitting = null
    }
  })
}

export function replaceAcpConversation(
  key: string,
  conversation: AcpConversation
): void {
  const before = acpStore.get().conversations
  const previous = before[key]
  const next = withLiveReplyTarget(previous, conversation)
  if (admits && before === admitting) {
    // What was derived from it while the list came in (a row's status read between two entries) no longer stands.
    for (const entry of derived) entry.drop(before)
    if (quiet === before) quiet = null
    before[key] = next
    return
  }
  const oldKeys = previous ? lookupKeys(previous) : []
  const newKeys = lookupKeys(next)
  const moved = !previous || railFactsMoved(previous, next) || overtakes(before, key, previous, next, oldKeys)
  const conversations = { ...before, [key]: next }
  carryThreadIndex(before, conversations, key, oldKeys, newKeys)
  if (saysTheSame(previous, next)) carrySayings(before, conversations)
  if (!moved) {
    for (const entry of derived) entry.carry(before, conversations)
    if (before === quiet || before === railAcpStore.get().conversations) quiet = conversations
  }
  if (admits) admitting = conversations
  acpStore.set({ conversations })
}

function carrySayings(before: Conversations, after: Conversations): void {
  carried(finByThread, before, after)
  carried(byThread, before, after)
  carried(listedByThread, before, after)
}

export function updateAcpConversation(
  key: string,
  update: (conversation: AcpConversation) => AcpConversation
): AcpConversation | null {
  const current = acpStore.get().conversations[key]
  if (!current) return null
  const next = update(current)
  if (next === current) return current
  replaceAcpConversation(key, next)
  return next
}

export function removeAcpConversation(key: string): AcpConversation | null {
  const state = acpStore.get()
  const current = state.conversations[key]
  if (!current) return null
  const conversations = { ...state.conversations }
  delete conversations[key]
  carryThreadIndex(state.conversations, conversations, key, lookupKeys(current), [])
  if (saysTheSame(current, undefined)) carrySayings(state.conversations, conversations)
  acpStore.set({
    conversations,
    activeKey: state.activeKey === key ? null : state.activeKey,
  })
  return current
}
