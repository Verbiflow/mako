import type { PromptVersions } from "@mako/host/contracts/live-conversations"
import { getMako, hasBridge } from "@/lib/bridge"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { readLive } from "@/state/live-recovery"
import { createHook, createStore } from "@/state/store"

/**
 * Each sent prompt's versions (`PromptVersions`), as its conversation's host answers them: the conversation it was
 * first sent in, then each fork made from just before it, which holds the words written again. Keyed by the
 * conversation on screen and the prompt.
 */
export const promptVersionsStore = createStore<{ answers: Readonly<Record<string, PromptVersions>> }>({ answers: {} })
export const usePromptVersions = createHook(promptVersionsStore)

export const promptVersionsKey = (conversation: string, requestId: string) => `${conversation}\0${requestId}`

/** Asks the host again: a fork made since may be one more version. A host without the call has one version to say. */
export function loadPromptVersions(conversation: string, requestId: string): void {
  if (!hasBridge()) return
  void getMako().livePromptVersions(conversation, requestId).then((answer) => {
    const key = promptVersionsKey(conversation, requestId)
    const known = promptVersionsStore.get().answers[key]
    if (known && known.at === answer.at && known.conversations.join() === answer.conversations.join()) return
    promptVersionsStore.set({ answers: { ...promptVersionsStore.get().answers, [key]: answer } })
  }, (error: Error) => console.warn(`A prompt's versions couldn't be read ${JSON.stringify({ conversation, requestId, error: error.message })}`))
}

/** Opens the conversation holding another version, read in first when this window hasn't it yet. */
export async function showPromptVersion(conversation: string): Promise<void> {
  if (!acpStore.get().conversations[conversation]) await readLive(conversation, () => getMako().liveSnapshot(conversation))
  acp.open(conversation)
}
