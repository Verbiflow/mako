import { Avatar } from "@/components/ui/avatar"
import { ApexMark } from "@/components/ui/apex-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useDeskIdentity } from "@/components/identity/desk-identity"
import { cn } from "@/lib/utils"

/**
 * Who wrote a message, as a square at its edge: the person's own face on their
 * prompts, and an agent's tile (its harness's glyph on the raised plane) on
 * what an agent wrote, whether it answers here, an Apex briefs its Fin, or a
 * Fin reports to its Apex. Square and small like every mark of Mako's, so a
 * transcript where several agents and the person talk reads by who at a glance.
 */
export function PersonAvatar({ className }: { className?: string }) {
  const identity = useDeskIdentity()
  const name = identity.kind === "none" ? "You" : identity.name
  const avatar = identity.kind === "none" ? undefined : identity.avatar
  return (
    <span data-message-avatar="person" title={name} className={cn("flex shrink-0", className)}>
      <Avatar src={avatar} name={name} size={6} />
    </span>
  )
}

/** An agent's tile: its harness when known, else the Apex mark. */
export function AgentAvatar({ harness, label, className }: { harness?: string; label?: string; className?: string }) {
  return (
    <span
      data-message-avatar="agent"
      title={label}
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-[3px] bg-raised [&>svg]:size-3.5 [&>span]:size-3.5", className)}
    >
      {harness ? <HarnessIcon harness={harness} /> : <ApexMark />}
    </span>
  )
}
