import type { PromptVersionsByRequest } from "@mako/host/contracts/live-conversations"
import { getMako, hasBridge } from "@/lib/bridge"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { readLive } from "@/state/live-recovery"
import { createHook, createStore } from "@/state/store"

/**
 * Each conversation's edited prompts' versions (`PromptVersions`), by request, as its host answers them: asked once a
 * conversation, however many of its prompts are on screen, and again only when the window holds another conversation
 * (a fork made since may be one more version).
 */
export const promptVersionsStore = createStore<{ answers: Readonly<Record<string, PromptVersionsByRequest>> }>({ answers: {} })
export const usePromptVersions = createHook(promptVersionsStore)

/** The question asked or being asked of each conversation: its id and how many conversations the window held. */
const asked = new Map<string, number>()

export function loadPromptVersions(conversation: string, held: number): void {
  if (!hasBridge() || asked.get(conversation) === held) return
  asked.set(conversation, held)
  void getMako().livePromptVersions(conversation).then((answer) => {
    const known = promptVersionsStore.get().answers[conversation]
    if (known && JSON.stringify(known) === JSON.stringify(answer)) return
    promptVersionsStore.set({ answers: { ...promptVersionsStore.get().answers, [conversation]: answer } })
  }, (error: Error) => {
    // Asked again by the next prompt that mounts.
    asked.delete(conversation)
    console.warn(`A conversation's prompt versions couldn't be read ${JSON.stringify({ conversation, error: error.message })}`)
  })
}

/** Opens the conversation holding another version, read in first when this window hasn't it yet. */
export async function showPromptVersion(conversation: string): Promise<void> {
  if (!acpStore.get().conversations[conversation]) await readLive(conversation, () => getMako().liveSnapshot(conversation))
  acp.open(conversation)
}
