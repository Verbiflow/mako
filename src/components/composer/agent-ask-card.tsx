import { HarnessIcon } from "@/components/ui/provider-icon"
import { askNotice } from "@/lib/ask-card"
import { useHarnessLabels } from "@/lib/harness-label"
import type { ComposerNotice } from "@/extend/notices"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { agentAskCard, agentAskOf } from "@/state/agent-asks"
import { bringBack } from "@/state/cloud-moves"

/**
 * What the agent on screen asked below full access through Mako's tools, read from its conversation, so every window
 * and device shows the one ask: the card every ask is drawn as (`askNotice`). A notice producer (`registerNotice`).
 */
export function useAgentAskNotice(): ComposerNotice | null {
  return useAskNotice(bringBack)
}

/** `pressBack`: how this form brings a Thread back, once the person allows its agent's ask to come back. */
export function useAskNotice(pressBack: (conversationId: string) => void): ComposerNotice | null {
  const labels = useHarnessLabels()
  const live = useAcp((state) => activeLiveAcp(state))
  const ask = agentAskOf(live ?? undefined)
  if (!live || !ask) return null
  return askNotice("agent-ask", agentAskCard(live.key, ask, labels[live.harness] ?? live.harness, pressBack), {
    icon: <HarnessIcon harness={live.harness} />,
    data: { "data-agent-ask": ask.want.kind },
  })
}
