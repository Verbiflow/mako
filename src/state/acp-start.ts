import { stagePrompt } from "@/state/acp-pending"
import { noteFolderUse, prefsStore } from "@/state/prefs"
import { projectAcp } from "@/state/live-projection"
import {
  currentSettingsTarget,
  settingsForSend,
  type ComposerTarget,
} from "@/state/composer-settings"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { getMako } from "@/lib/bridge"
import type { AcpBlock } from "@/lib/acp-blocks"
import { isHostReconnectingError } from "../../electron/contracts/host-connection"
import type { LiveStartOptions, LiveSnapshot, PromptAttachment } from "@/lib/types"
import {
  acpStore,
  removeAcpConversation,
  replaceAcpConversation,
  updateAcpConversation,
  type StartingAcpConversation,
} from "@/state/acp-state"
import { toast } from "sonner"
import { commandId, durableAttachments, pendingMessages, saveMessage, settleMessage, type OutboxCommand } from "@/state/message-outbox"

export type AcpStartOptions = Omit<
  NonNullable<Parameters<ReturnType<typeof getMako>["liveStart"]>[2]>,
  "conversationId"
>

const MAX_PROMPT_TITLE = 60

/** The first line of a prompt, as the rail names every other thread. */
export function titleFromPrompt(prompt: string): string | undefined {
  const text = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !/^\[[^\]]+\]$/.test(line))
  if (!text) return undefined
  return text.length > MAX_PROMPT_TITLE
    ? `${text.slice(0, MAX_PROMPT_TITLE - 1)}…`
    : text
}

interface BeginStartInput {
  settingsTarget?: ComposerTarget
  harness: string
  cwd: string
  title?: string
  threadPath?: string
  blocks: AcpBlock[]
  hiddenUserPrompt: string | null
}

export function beginStart(input: BeginStartInput): StartingAcpConversation {
  const now = Date.now()
  noteFolderUse(input.cwd)
  const key = crypto.randomUUID()
  const conversation: StartingAcpConversation = {
    kind: "starting",
    settingsTarget:
      input.settingsTarget ?? currentSettingsTarget(input.harness),
    key,
    draftKey: input.threadPath ?? key,
    harness: input.harness,
    cwd: input.cwd,
    title: input.title,
    threadPath: input.threadPath,
    blocks: input.blocks,
    queued: [],
    hiddenUserPrompt: input.hiddenUserPrompt,
    createdAt: now,
    updatedAt: now,
  }
  conversation.projection = projectAcp(conversation)
  replaceAcpConversation(key, conversation)
  acpStore.set({ activeKey: key })
  return conversation
}

export function updateStarting(
  key: string,
  patch: Partial<Pick<StartingAcpConversation, "hiddenUserPrompt" | "blocks">>
): void {
  updateAcpConversation(key, (conversation) =>
    conversation.kind === "starting"
      ? {
          ...conversation,
          ...patch,
          updatedAt: Date.now(),
          projection: projectAcp({ ...conversation, ...patch }),
        }
      : conversation
  )
}

export function failStart(key: string): void {
  removeAcpConversation(key)
}

export function waitForPromotion(draftKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const conversation = Object.values(acpStore.get().conversations).find(
        (candidate) => candidate.draftKey === draftKey
      )
      if (conversation?.kind === "live") {
        unsubscribe()
        resolve(true)
      } else if (!conversation) {
        unsubscribe()
        resolve(false)
      }
    }
    const unsubscribe = acpStore.subscribe(check)
    check()
  })
}

export async function launch(
  starting: StartingAcpConversation,
  options: AcpStartOptions,
  prompt?: string,
  attachments: PromptAttachment[] = []
): Promise<boolean> {
  const requestId = crypto.randomUUID()
  attachments = durableAttachments(attachments)
  if (prompt !== undefined) {
    const blocks = starting.blocks.map((block) =>
      block.type === "user" ? { ...block, requestId } : block
    )
    updateStarting(starting.key, { blocks })
    stagePrompt(starting.key, {
      id: requestId,
      text: prompt,
      attachments,
      displayText: starting.hiddenUserPrompt
        ? blocks
            .filter((block) => block.type === "user")
            .map((block) => block.text)
            .join("\n")
        : undefined,
    })
  }
  try {
    const input: LiveStartOptions = {
      ...options,
      modeId: options.modeId ?? prefsStore.get().providerModes[starting.harness],
      tuning:
        options.tuning ?? (await settingsForSend(starting.settingsTarget)),
      conversationId: starting.key,
      threadPath: starting.threadPath,
      displayPrompt: starting.hiddenUserPrompt
        ? starting.blocks
            .filter((block) => block.type === "user")
            .map((block) => block.text)
            .join("\n")
        : undefined,
      initialRequest:
        prompt === undefined
          ? undefined
          : { id: requestId, text: prompt, attachments },
    }
    saveMessage({ kind: "start", args: [starting.harness, starting.cwd, input], draftKey: starting.draftKey })
    return deliverStart(starting, input)
  } catch (error) {
    failStart(starting.key)
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

const startRetries = new Map<string, ReturnType<typeof setTimeout>>()
const startDeliveries = new Map<string, Promise<boolean>>()
const retryDelays = new Map<string, number>()

export async function restorePendingStart(command: Extract<OutboxCommand, { kind: "start" }>): Promise<void> {
  const [harness, cwd, input] = command.args
  const starting: StartingAcpConversation = { kind: "starting", key: input.conversationId, draftKey: command.draftKey,
    settingsTarget: currentSettingsTarget(harness), harness, cwd, threadPath: input.threadPath, title: input.title,
    blocks: [], queued: [], hiddenUserPrompt: null, createdAt: Date.now(), updatedAt: Date.now(), unconfirmedStart: input }
  const existing = acpStore.get().conversations[input.conversationId]
  if (existing?.kind === "live") {
    const snapshot = await getMako().liveSnapshot(existing.key).catch(() => null)
    if (snapshot && (!input.initialRequest || snapshot.requests.some((request) => request.id === input.initialRequest?.id))) {
      adoptStart(starting, snapshot, input)
      settleMessage(commandId(command))
      return
    }
  }
  if (!existing) replaceAcpConversation(starting.key, starting)
  await deliverStart(starting, input)
}

function adoptStart(starting: StartingAcpConversation, snapshot: LiveSnapshot, input: LiveStartOptions): void {
  const selected = acpStore.get().activeKey === starting.key
  const pending = acpStore.get().conversations[starting.key]?.pendingPrompts
  const bindingId = input.resume
    ? snapshot.control?.bindings.find((binding) => binding.provider === starting.harness && binding.nativeId === input.resume)?.id
    : input.conversationId
  applyLiveSnapshot(snapshot, bindingId)
  updateAcpConversation(snapshot.session.id, (current) => ({ ...current, draftKey: starting.draftKey }))
  // Persist the winning target before acknowledging the start. A reload at any
  // point can recover either the original start or these resolved follow-ups.
  for (const command of pendingMessages()) {
    if (command.kind !== "queued" || command.startId !== starting.key) continue
    saveMessage({ kind: "prompt", conversationId: snapshot.session.id, requestId: command.requestId,
      text: command.text, attachments: command.attachments, tuning: command.tuning, bindingId })
    updateAcpConversation(snapshot.session.id, (current) => ({ ...current,
      pendingPrompts: current.pendingPrompts?.filter((prompt) => prompt.id !== command.requestId),
    }))
    stagePrompt(snapshot.session.id, { id: command.requestId, text: command.text, attachments: command.attachments,
      bindingId, delivery: { tuning: command.tuning }, unconfirmed: true })
  }
  for (const prompt of pending ?? []) {
    if (!snapshot.requests.some((request) => request.id === prompt.id) &&
        !snapshot.control?.transfers.some((transfer) => transfer.input.id === prompt.id)) stagePrompt(snapshot.session.id, prompt)
  }
  if (snapshot.session.id !== starting.key) removeAcpConversation(starting.key)
  if (selected) acpStore.set({ activeKey: snapshot.session.id })
}

function deliverStart(starting: StartingAcpConversation, input: LiveStartOptions): Promise<boolean> {
  const existing = startDeliveries.get(starting.key)
  if (existing) return existing
  const delivery = attemptStart(starting, input).finally(() => startDeliveries.delete(starting.key))
  startDeliveries.set(starting.key, delivery)
  return delivery
}

async function attemptStart(starting: StartingAcpConversation, input: LiveStartOptions): Promise<boolean> {
  clearTimeout(startRetries.get(starting.key))
  startRetries.delete(starting.key)
  try {
    adoptStart(starting, await getMako().liveStart(starting.harness, starting.cwd, input), input)
    settleMessage(input.initialRequest?.id ?? input.conversationId)
    retryDelays.delete(starting.key)
    return true
  } catch (error) {
    let accepted = await getMako().liveSnapshot(starting.key).catch(() => null)
    if (accepted && input.initialRequest && !accepted.requests.some((request) => request.id === input.initialRequest?.id) &&
        !accepted.control?.transfers.some((transfer) => transfer.input.id === input.initialRequest?.id)) accepted = null
    if (!accepted && input.resume && input.threadPath) {
      const resolved = await getMako().resolveContinuation(input.threadPath).catch(() => null)
      if (resolved?.transport === "attached" && (!input.initialRequest ||
          resolved.snapshot.requests.some((request) => request.id === input.initialRequest?.id) ||
          resolved.snapshot.control?.transfers.some((transfer) => transfer.input.id === input.initialRequest?.id)))
        accepted = resolved.snapshot
    }
    if (accepted) {
      adoptStart(starting, accepted, input)
      settleMessage(input.initialRequest?.id ?? input.conversationId)
      retryDelays.delete(starting.key)
      return true
    }
    if (starting.unconfirmedStart || (error instanceof Error && isHostReconnectingError(error))) {
      updateAcpConversation(starting.key, (current) => current.kind === "starting"
        ? { ...current, unconfirmedStart: input } : current)
      // Retain the complete original command. The owner may have accepted it
      // under a different conversation ID while two hosts raced to resume.
      const delay = retryDelays.get(starting.key) ?? 2_000
      retryDelays.set(starting.key, Math.min(delay * 2, 30_000))
      const timer = setTimeout(() => {
        const current = acpStore.get().conversations[starting.key]
        if (current) void deliverStart({ ...starting, unconfirmedStart: input }, input)
      }, delay)
      startRetries.set(starting.key, timer)
      return true
    }
    settleMessage(input.initialRequest?.id ?? input.conversationId)
    failStart(starting.key)
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}
