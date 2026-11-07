import { agentAskWords } from "@mako/host/contracts/agent-asks"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useHarnessLabels } from "@/lib/harness-label"
import type { ComposerNotice } from "@/extend/notices"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { agentAskOf, answerAgentAsk } from "@/state/agent-asks"
import { bringBack } from "@/state/cloud-moves"

/**
 * What the agent on screen asked below full access through Mako's tools, read from its conversation, so every window
 * and device shows the one ask. A notice producer (`registerNotice`); the web app's dock draws the same words.
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
  const words = agentAskWords(ask.want, labels[live.harness] ?? live.harness)
  return {
    id: "agent-ask",
    tone: "caution",
    priority: 0,
    icon: <HarnessIcon harness={live.harness} />,
    title: words.title,
    description: words.description,
    detail: <p>{words.detail}</p>,
    actions: [
      {
        label: words.allow,
        primary: true,
        onClick: () =>
          void answerAgentAsk(live.key, ask, true).then((answered) => {
            if (answered && ask.want.kind === "back") pressBack(live.key)
          }),
      },
      { label: words.keep, onClick: () => void answerAgentAsk(live.key, ask, false) },
    ],
    data: { "data-agent-ask": ask.want.kind },
  }
}
