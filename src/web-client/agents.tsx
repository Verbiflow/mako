import { use, useCallback, useEffect } from "react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { agentsPanelChunk } from "./chunks"
import { CodeLine, CodeSlowLine } from "./code-unavailable"
import { OpenChildContext } from "./fin-of-apex"
import { Sheet } from "./sheet"

/**
 * A phone's Agents panel: the conversation's roster as the desk's panel draws it (subagents, background commands and
 * agents, each with its harness's mark, state, last step and counts), at half the screen and pulled up to all of it.
 */
export function AgentsSheet({ conversation, open, onDismiss }: { conversation: string; open: boolean; onDismiss: () => void }) {
  // An Apex's Fin opens over its Apex on the phone, the sheet put away.
  const openChild = use(OpenChildContext)
  const opened = useCallback(
    (agent: NativeAgent) => {
      onDismiss()
      openChild?.(agent)
    },
    [onDismiss, openChild]
  )
  const panel = agentsPanelChunk.use()
  const failed = agentsPanelChunk.useFailed()
  const slow = agentsPanelChunk.useSlow()
  const readPanel = useCallback(() => agentsPanelChunk.read().then(() => undefined), [])
  useEffect(() => {
    if (open && !panel) void readPanel().catch(() => undefined)
  }, [open, panel, readPanel])
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Agents" expandable>
      <h3 className="web-sheet-title">Agents</h3>
      <div data-agents-sheet className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
        {!open ? null : panel ? <panel.ConversationAgents conversation={conversation} transcripts={false} onOpenChild={openChild ? opened : undefined} /> : failed ? (
          <CodeLine what="The agents" retry={readPanel} className="py-4" />
        ) : (
          <CodeSlowLine what="the agents" slow={slow} className="px-4 py-4" />
        )}
      </div>
    </Sheet>
  )
}
