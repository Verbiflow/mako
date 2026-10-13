import { toast } from "sonner"
import { SIDE_QUESTION_LIMIT } from "@mako/host/contracts/live-side-questions"
import { acpStore, activeAcp, activeLiveAcp } from "@/state/acp"
import { createHook, createStore } from "@/state/store"
import { threadsStore } from "@/state/thread-store"
import { harnessLabel } from "@/lib/harness-label"

/** `/btw` or `/side` and the words after it, as the composer's own command. */
const SIDE_LINE = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/

export type SideLine = { kind: "open" } | { kind: "ask"; question: string } | { kind: "too-long"; length: number }

/** What a draft asks of the side conversation, or null when it is an ordinary message. */
export function readSideLine(draft: string): SideLine | null {
  const match = SIDE_LINE.exec(draft.trim())
  if (!match) return null
  const question = match[1]?.trim() ?? ""
  if (!question) return { kind: "open" }
  if (question.length > SIDE_QUESTION_LIMIT) return { kind: "too-long", length: question.length }
  return { kind: "ask", question }
}

interface SidePanelState {
  /** Conversations whose side panel is open before their first side question. */
  open: ReadonlySet<string>
  /** Bumped to move focus into the side panel's field. */
  focus: number
}

export const sidePanelStore = createStore<SidePanelState>({ open: new Set(), focus: 0 })
export const useSidePanel = createHook(sidePanelStore)

export function openSidePanel(key: string): void {
  sidePanelStore.set(({ open, focus }) => ({ open: new Set(open).add(key), focus: focus + 1 }))
}

export function focusSidePanel(): void {
  sidePanelStore.set(({ focus }) => ({ focus: focus + 1 }))
}

export function forgetSidePanel(key: string): void {
  sidePanelStore.set(({ open }) => {
    if (!open.has(key)) return {}
    const next = new Set(open)
    next.delete(key)
    return { open: next }
  })
}

/** The live conversation a side question goes to, or why there isn't one. */
export function sideRoute(): { kind: "conversation"; key: string } | { kind: "elsewhere"; reason: string } {
  const conversation = activeAcp(acpStore.get())
  const live = activeLiveAcp(acpStore.get())
  const viewing = threadsStore.get().viewing?.ref
  if (viewing && (!live || viewing.path !== conversation?.threadPath))
    return { kind: "elsewhere", reason: "Send a message to reopen this conversation, then ask a side question." }
  if (!conversation) return { kind: "elsewhere", reason: "Start a conversation first, then ask a side question about it." }
  if (conversation.kind !== "live") return { kind: "elsewhere", reason: `Wait for ${harnessLabel(conversation.harness)} to start, then ask a side question.` }
  return { kind: "conversation", key: conversation.key }
}

/** Sends what a `/btw` draft asks; false keeps the draft. */
export async function sendSideLine(line: SideLine, ask: (question: string, key: string) => Promise<boolean>): Promise<boolean> {
  if (line.kind === "too-long") {
    toast.error(`A side question can be up to ${SIDE_QUESTION_LIMIT.toLocaleString()} characters. This one is ${line.length.toLocaleString()}; shorten it and try again.`)
    return false
  }
  const route = sideRoute()
  if (route.kind === "elsewhere") {
    toast.error(route.reason)
    return false
  }
  if (line.kind === "open") {
    openSidePanel(route.key)
    return true
  }
  const asked = await ask(line.question, route.key)
  if (asked) focusSidePanel()
  return asked
}
