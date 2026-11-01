import { ConversationAgents } from "@/components/inspector/agents-panel"
import { Sheet } from "./sheet"

/**
 * A phone's Agents panel: the conversation's roster as the desk's panel draws it (subagents, background commands and
 * agents, each with its harness's mark, state, last step and counts), at half the screen and pulled up to all of it.
 */
export function AgentsSheet({ conversation, open, onDismiss }: { conversation: string; open: boolean; onDismiss: () => void }) {
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Agents" expandable>
      <h3 className="web-sheet-title">Agents</h3>
      <div data-agents-sheet className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
        {open ? <ConversationAgents conversation={conversation} transcripts={false} /> : null}
      </div>
    </Sheet>
  )
}
