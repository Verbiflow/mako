import { useEffect } from "react"
import { askNotice } from "@/lib/ask-card"
import type { ComposerNotice } from "@/extend/notices"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { activeAcp, useAcp } from "@/state/acp"
import { readSetupIfOld, setupAskCard, useAway, useSetup } from "@/state/setup"

/**
 * Above the composer of a Thread whose agent asked for something its place lacks (a repository, a file, access, a
 * tool): the ask card every surface draws, with the same answers its Setup and the Inbox give. A notice producer
 * (`registerNotice`).
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
  return askNotice("setup-ask", setupAskCard(cwd, ask, away), {
    ...(ask.by.harness && { icon: <HarnessIcon harness={ask.by.harness} /> }),
    data: { "data-setup-ask-notice": ask.id },
  })
}
