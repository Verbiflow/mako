import { childStateOf, childTime } from "@mako/host/contracts/children"
import { isActiveNativeAgent, type NativeAgent } from "@mako/host/contracts/native-agents"
import { durationText } from "@mako/sessions/events"
import { useSecondClock } from "@/components/ui/second-clock"
import { cn } from "@/lib/utils"

/** How long it has run, counting while it runs; one shared clock ticks every row. A Fin says how long it has stood as it does (`since`). */
export function Elapsed({ agent, className }: { agent: NativeAgent; className?: string }) {
  const active = isActiveNativeAgent(agent)
  const fin = agent.child !== undefined
  const now = useSecondClock(active || fin)
  const start = agent.startedAt ?? agent.observedAt
  const end = active ? now : (agent.settledAt ?? agent.observedAt)
  if (fin) {
    const { time, title } = childTime(childStateOf(agent), agent.since === undefined ? 0 : now - agent.since)
    return time ? <span title={title} className={cn("tabular shrink-0", className)}>{time}</span> : null
  }
  const ms = agent.usage?.durationMs !== undefined && !active ? agent.usage.durationMs : end - start
  if (ms < 1_000) return null
  return <span className={cn("tabular shrink-0", className)}>{durationText(ms)}</span>
}
