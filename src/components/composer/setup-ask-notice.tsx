import { useEffect } from "react"
import { askAnswerLabel, askAnswers, SETUP_AWAY_ALLOW } from "@mako/host/contracts/setup"
import type { ComposerNotice } from "@/extend/notices"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { activeAcp, useAcp } from "@/state/acp"
import { answerAsk, readSetupIfOld, setupAskWords, useAway, useSetup } from "@/state/setup"

/**
 * Above the composer of a Thread whose agent asked for something its place lacks (a repository, a file, access, a
 * tool): "Waiting on you", with the same answers its Setup and the Inbox give. A notice producer (`registerNotice`).
 */
export function useSetupAskNotice(): ComposerNotice | null {
  const cwd = useAcp((state) => activeAcp(state)?.cwd)
  const thread = useAcp((state) => activeAcp(state)?.threadId)
  const ask = useSetup((state) => (cwd && thread ? state.byFolder[cwd]?.places.flatMap((place) => place.asks).find((entry) => entry.by.thread === thread) : undefined))
  const away = useAway(cwd ?? "")
  useEffect(() => {
    if (cwd) readSetupIfOld(cwd)
  }, [cwd])
  if (!ask || !cwd) return null
  const [first, ...rest] = askAnswers(ask, away)
  return {
    id: "setup-ask",
    tone: "attention",
    ...(ask.by.harness && { icon: <HarnessIcon harness={ask.by.harness} /> }),
    title: "Waiting on you",
    description: away && askAnswers(ask).length > 1 ? `${setupAskWords(ask)}. ${SETUP_AWAY_ALLOW}` : setupAskWords(ask),
    detail: <p>“{ask.why}”. Answering here is the same as in this Thread&apos;s Setup and your Inbox; nothing is added until you do.</p>,
    actions: [
      { label: askAnswerLabel(ask, first!, true), primary: !away, onClick: () => answerAsk(cwd, ask, first!) },
      ...rest.map((answer) => ({ label: askAnswerLabel(ask, answer, true), onClick: () => answerAsk(cwd, ask, answer) })),
    ],
    data: { "data-setup-ask-notice": ask.id },
  }
}
