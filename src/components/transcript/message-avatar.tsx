import { Avatar } from "@/components/ui/avatar"
import { LiveMark } from "@/components/ui/live-mark"
import type { LiveMarkKind } from "@/lib/live-mark-state"
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

/**
 * An agent's square: Mako's fin, still (the two-tone fin for a Thread, the plain fin for a Fin), its harness as the
 * corner badge when known.
 */
export function AgentAvatar({ harness, kind = "thread", label, className }: { harness?: string; kind?: LiveMarkKind; label?: string; className?: string }) {
  return (
    <span data-message-avatar="agent" data-avatar-kind={kind} title={label} className={cn("flex size-6 shrink-0 items-center justify-center bg-raised", className)}>
      <StillMark harness={harness} kind={kind} cut="var(--raised)" label={label} />
    </span>
  )
}

/** A Thread or Fin named inline where its state isn't the point ("To Dictation fallback"): its fin, still, the harness its badge. */
export function StillMark({ harness, kind = "fin", size = 20, cut, label, className }: { harness?: string; kind?: LiveMarkKind; size?: number; cut?: string; label?: string; className?: string }) {
  return (
    <LiveMark state="idle" kind={kind} size={size} cut={cut} className={cn("live-mark-still", className)} label={label}>
      {harness ? <HarnessIcon harness={harness} /> : null}
    </LiveMark>
  )
}
