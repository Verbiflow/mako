import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { childStateOf, endedUnfinished } from "@mako/host/contracts/children"
import { cn } from "@/lib/utils"
import { acp } from "@/state/acp"
import { address, addresseeOf } from "@/state/apex-fins"

/**
 * What the person can do with one Fin, from any row that lists it (the Shiver card, the side rail): write to it, which
 * also resumes one stopped or failed, or stop it. Opening it is the row itself. Shown while the row is hovered or
 * focused, and always (`always`) when the row is itself a question for the person, such as a quiet Fin.
 */
export function FinRowActions({ agent, conversation, always = false, className }: {
  agent: NativeAgent
  /** The Apex's conversation: its composer is the one addressed, and its host stops the Fin. */
  conversation: string | undefined
  always?: boolean
  className?: string
}) {
  const addressee = addresseeOf(agent)
  const state = childStateOf(agent)
  const message = endedUnfinished(state) ? "Continue" : state.kind === "ended" && state.outcome === "failed" ? "Retry" : state.kind === "ended" && state.outcome === "stopped" ? "Resume" : "Message"
  const canMessage = Boolean(conversation && addressee)
  const canStop = Boolean(conversation && agent.stoppable)
  if (!canMessage && !canStop) return null
  const hint = message === "Message" ? `Write to ${agent.title} from this composer` : `Write to ${agent.title}: your message ${message === "Retry" ? "tries again from where it failed" : message === "Continue" ? "sends it on from where it ended" : "resumes it"}`
  return (
    <span
      data-fin-actions={agent.child?.thread}
      className={cn(
        "flex shrink-0 items-center",
        !always && "pointer-events-none opacity-0 group-hover/fin:pointer-events-auto group-hover/fin:opacity-100 group-focus-within/fin:pointer-events-auto group-focus-within/fin:opacity-100",
        className
      )}
    >
      {canMessage ? (
        <button
          type="button"
          data-fin-action={message.toLowerCase()}
          title={hint}
          onClick={() => {
            if (!conversation || !addressee) return
            address(conversation, addressee)
            window.dispatchEvent(new CustomEvent("mako:focus-composer"))
          }}
          className="pressable h-7 px-2 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          {message}
        </button>
      ) : null}
      {canStop ? (
        <button
          type="button"
          data-fin-action="stop"
          title={`Stop ${agent.title}; a message resumes it`}
          onClick={() => {
            if (conversation) void acp.stopAgent(conversation, agent.nativeId)
          }}
          className="pressable h-7 px-2 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          Stop
        </button>
      ) : null}
    </span>
  )
}
