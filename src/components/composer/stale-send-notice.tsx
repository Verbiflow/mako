import { HarnessIcon } from "@/components/ui/provider-icon"
import type { ComposerNotice } from "@/extend/notices"
import { sendHere, staleSendStore, useStaleSend } from "@/state/stale-send"

/**
 * One line above the composer when a send waits on the person (`asksBeforeSend`): the Session it would wake, how long
 * it has rested, and the one they worked in since. "Switch to the newest" is the filled one: that's where the words
 * were most likely meant to go.
 *
 * A notice producer (`registerNotice`).
 */
export function useStaleSendNotice(): ComposerNotice | null {
  const asking = useStaleSend((state) => state.asking)
  if (!asking) return null
  return {
    id: "stale-send",
    tone: "caution",
    icon: <HarnessIcon harness={asking.harness} />,
    title: asking.title,
    description: asking.detail,
    actions: [
      { label: "Send here", onClick: sendHere },
      { label: "Switch to the newest", primary: true, onClick: () => window.dispatchEvent(new Event("mako:stale-send-switch")) },
    ],
    onDismiss: () => staleSendStore.set({ asking: undefined }),
    dismissLabel: "Keep writing",
    data: { "data-stale-send": true },
  }
}
