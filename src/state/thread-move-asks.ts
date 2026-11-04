import { toast } from "sonner"
import type { ThreadMoveAsk } from "@mako/host/contracts/thread-tools"
import { getMako, hasBridge } from "@/lib/bridge"
import { harnessLabel } from "@/lib/harness-label"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { acpStore } from "@/state/acp-state"
import { createHook, createStore } from "@/state/store"

/** Agents' asks to move their Thread to the cloud, which the person answers above its composer. */
export const threadMoveAsksStore = createStore<{ asks: ThreadMoveAsk[] }>({ asks: [] })
export const useThreadMoveAsks = createHook(threadMoveAsksStore)

export function threadMoveAskFor(asks: readonly ThreadMoveAsk[], conversationId: string | null): ThreadMoveAsk | undefined {
  return conversationId ? asks.find((ask) => ask.conversationId === conversationId) : undefined
}

async function show(conversationId: string): Promise<void> {
  const { acp } = await import("@/state/acp")
  acp.activate(conversationId)
}

export function applyThreadMoveAsks(asks: ThreadMoveAsk[]): void {
  const known = new Set(threadMoveAsksStore.get().asks.map((ask) => ask.id))
  threadMoveAsksStore.set({ asks })
  for (const ask of asks) {
    if (known.has(ask.id) || acpStore.get().activeKey === ask.conversationId) continue
    toast(`${harnessLabel(ask.harness)} wants to move to the cloud`, {
      ...(ask.title && { description: ask.title }),
      duration: ACTION_TOAST_MS,
      action: { label: "Show", onClick: () => void show(ask.conversationId) },
    })
  }
}

export async function loadThreadMoveAsks(): Promise<void> {
  if (!hasBridge()) return
  applyThreadMoveAsks(await getMako().threadMoveAsks())
}

export async function answerThreadMoveAsk(id: string, allow: boolean): Promise<void> {
  try {
    await getMako().answerThreadMoveAsk(id, allow)
  } catch (error) {
    toast.error("Mako couldn't record that answer", { description: error instanceof Error ? error.message : String(error) })
  }
}
