import { isActiveNativeAgent, type NativeAgent } from "@mako/host/contracts/native-agents"
import { durationText } from "@mako/sessions/events"
import { useSecondClock } from "@/components/ui/second-clock"
import { cn } from "@/lib/utils"

/** How long it has run, counting while it runs; one shared clock ticks every row. */
export function Elapsed({ agent, className }: { agent: NativeAgent; className?: string }) {
  const active = isActiveNativeAgent(agent)
  const now = useSecondClock(active)
  const start = agent.startedAt ?? agent.observedAt
  const end = active ? now : (agent.settledAt ?? agent.observedAt)
  const ms = agent.usage?.durationMs !== undefined && !active ? agent.usage.durationMs : end - start
  if (ms < 1_000) return null
  return <span className={cn("tabular shrink-0", className)}>{durationText(ms)}</span>
}
