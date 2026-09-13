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
import type { PromptAttachment } from "@/lib/types"
import {
  acpStore,
  removeAcpConversation,
  replaceAcpConversation,
  updateAcpConversation,
  type StartingAcpConversation,
} from "@/state/acp-state"
import { toast } from "sonner"

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
    const snapshot = await getMako().liveStart(starting.harness, starting.cwd, {
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
    })
    applyLiveSnapshot(snapshot)
    return true
  } catch (error) {
    const accepted = await getMako()
      .liveSnapshot(starting.key)
      .catch(() => null)
    if (accepted) {
      applyLiveSnapshot(accepted)
      return true
    }
    failStart(starting.key)
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}
