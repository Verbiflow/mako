import type { PendingPrompt } from "@/state/prompt-delivery"
import type { ComposerTarget } from "@/state/composer-settings"
import type { LiveSnapshot, LiveStartOptions, ThreadRef } from "@/lib/types"
import type { LiveProjection } from "@/state/live-projection"
import type { AcpBlock } from "@/lib/acp-blocks"
import type {
  LivePermissionRequest,
  PromptAttachment,
  LiveSessionState,
} from "@/lib/types"
import { createHook, createStore } from "@/state/store"

export interface AcpQueuedPrompt {
  text: string
  attachments: PromptAttachment[]
}

interface AcpConversationBase {
  history?: LiveSnapshot["history"]
  replyBindingId?: string
  pendingPrompts?: PendingPrompt[]
  nativeAgents?: LiveSnapshot["nativeAgents"]
  key: string
  draftKey: string
  harness: string
  cwd: string
  title?: string
  nativePaths?: string[]
  threadPath?: string
  control?: LiveSnapshot["control"]
  requests?: LiveSnapshot["requests"]
  base?: LiveSnapshot["base"]
  baseCoveredBlocks?: number
  revision?: number
  /** The host generation that numbered `revision`; a batch from another epoch is never merged onto this state. */
  epoch?: string
  hydrated?: boolean
  projection?: LiveProjection
  blocks: AcpBlock[]
  queued: AcpQueuedPrompt[]
  hiddenUserPrompt: string | null
  createdAt: number
  updatedAt: number
}

export interface StartingAcpConversation extends AcpConversationBase {
  unconfirmedStart?: LiveStartOptions
  settingsTarget: ComposerTarget
  kind: "starting"
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
}

export const acpStore = createStore<AcpState>({
  activeKey: null,
  conversations: {},
})

export const useAcp = createHook(acpStore)

export function activeAcp(state: AcpState): AcpConversation | null {
  return state.activeKey ? (state.conversations[state.activeKey] ?? null) : null
}

export function activeLiveAcp(state: AcpState): LiveAcpConversation | null {
  const active = activeAcp(state)
  return active?.kind === "live" ? active : null
}

const threadIndexes = new WeakMap<
  AcpState["conversations"],
  Map<string, Set<string>>
>()

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
  before: AcpState["conversations"],
  after: AcpState["conversations"],
  id: string
): void {
  const held = threadIndexes.get(before)
  if (!held) return
  const oldKeys = before[id] ? lookupKeys(before[id]) : []
  const newKeys = after[id] ? lookupKeys(after[id]) : []
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
      conversation.session.status !== "closed"
    const ownsIdentity =
      identity &&
      conversation.kind === "live" &&
      conversation.session.harness === identity.harness &&
      conversation.session.nativeId === identity.nativeId
    if (
      available &&
      (ownsIdentity ||
        ((!identity || conversation.harness === identity.harness) &&
          (conversation.threadPath === path ||
            conversation.nativePaths?.includes(path))) ||
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

export function replaceAcpConversation(
  key: string,
  conversation: AcpConversation
): void {
  const before = acpStore.get().conversations
  const conversations = { ...before, [key]: conversation }
  carryThreadIndex(before, conversations, key)
  acpStore.set({ conversations })
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
  carryThreadIndex(state.conversations, conversations, key)
  acpStore.set({
    conversations,
    activeKey: state.activeKey === key ? null : state.activeKey,
  })
  return current
}
