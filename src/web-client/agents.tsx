import { use, useCallback } from "react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { ConversationAgents } from "@/components/inspector/agents-panel"
import { OpenChildContext } from "./child-of-lead"
import { Sheet } from "./sheet"

/**
 * A phone's Agents panel: the conversation's roster as the desk's panel draws it (subagents, background commands and
 * agents, each with its harness's mark, state, last step and counts), at half the screen and pulled up to all of it.
 */
export function AgentsSheet({ conversation, open, onDismiss }: { conversation: string; open: boolean; onDismiss: () => void }) {
  // A lead's child opens over its lead on the phone, the sheet put away.
  const openChild = use(OpenChildContext)
  const opened = useCallback(
    (agent: NativeAgent) => {
      onDismiss()
      openChild?.(agent)
    },
    [onDismiss, openChild]
  )
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Agents" expandable>
      <h3 className="web-sheet-title">Agents</h3>
      <div data-agents-sheet className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
        {open ? <ConversationAgents conversation={conversation} transcripts={false} onOpenChild={openChild ? opened : undefined} /> : null}
      </div>
    </Sheet>
  )
}
