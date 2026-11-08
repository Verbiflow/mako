import type { CSSProperties, ReactNode } from "react"
import type { ChildGroup, Rollup } from "@mako/host/contracts/children"
import { isActiveNativeAgent, type NativeAgent } from "@mako/host/contracts/native-agents"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useSecondClock } from "@/components/ui/second-clock"
import { cn } from "@/lib/utils"
import { pipGroup, type Fin, type MarkState } from "./data"
import { markWord } from "./mark-word"

/**
 * One mark for who and how: the agent's own glyph, and around it the state. A comet runs round it while it works,
 * a caution ring breathes while it waits on you, a dotted ring drifts while a Fin asks its Apex, a dashed one holds
 * while it's queued; a dot says it failed or that an answer waits to be read.
 */
/**
 * Every mark runs on one clock: its delay puts it where a mark started at the epoch would be, so a row that re-sorts
 * or remounts never restarts its motion or drifts out of step with the others. Still screenshots pin one moment.
 */
const STILL = "still" in document.documentElement.dataset
function sync(period: number): string {
  return `${-((STILL ? 420 : Date.now()) % period)}ms`
}

export function LiveMark({ harness, state, lit, cut, className }: { harness: string; state: MarkState; lit?: boolean; cut?: string; className?: string }) {
  const style: CSSProperties & { "--sync-turn": string; "--sync-tail": string; "--sync-slow": string; "--sync-breathe": string; "--lm-cut"?: string } = { "--sync-turn": sync(1150), "--sync-tail": sync(2300), "--sync-slow": sync(2300), "--sync-breathe": sync(2400), ...(cut && { "--lm-cut": cut }) }
  return (
    <span role="img" aria-label={markWord(state)} data-state={state} data-lit={lit || undefined} className={cn("lm", className)} style={style}>
      <svg aria-hidden viewBox="0 0 20 20" className="lm-ring">
        <circle className="lm-track" cx="10" cy="10" r="9.25" />
        <circle className="lm-arc" cx="10" cy="10" r="9.25" />
      </svg>
      <HarnessIcon harness={harness} className="lm-glyph" />
      <span aria-hidden className="lm-badge" />
    </span>
  )
}

/** An Apex's crew in a row of pips, one per Fin, needs-you first. */
export function Pips({ fins, className }: { fins: Fin[]; className?: string }) {
  let working = 0
  return (
    <span className={cn("pips", className)} aria-hidden>
      {fins.map((fin) => {
        const group = pipGroup(fin.state)
        const index = group === "working" || group === "lead" ? working++ : 0
        const style: CSSProperties & { "--i": number } = { "--i": index }
        return <span key={fin.agent.nativeId} className="pip" data-group={group} style={style} />
      })}
    </span>
  )
}

const ORDER: ChildGroup[] = ["needs", "working", "idle", "queued", "failed", "done"]

export function CrewBar({ counts, className }: { counts: Rollup; className?: string }) {
  return (
    <span className={cn("crew-bar", className)} aria-hidden>
      {ORDER.filter((group) => counts[group] > 0).map((group) => (
        <span key={group} data-group={group} style={{ flexGrow: counts[group] }} />
      ))}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="capy-kbd font-sans">{children}</kbd>
}

/** How long a Fin has run, in one unit until an hour: "25s", "18m", "1h 4m". A queued Fin hasn't started, so it has none. */
export function Took({ agent, className }: { agent: NativeAgent; className?: string }) {
  const active = isActiveNativeAgent(agent)
  const now = useSecondClock(active)
  if (agent.child?.state?.kind === "queued") return null
  const ms = (active ? now : (agent.settledAt ?? agent.observedAt)) - (agent.startedAt ?? agent.observedAt)
  if (ms < 1_000) return null
  const seconds = Math.round(ms / 1_000)
  const text = seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
  return <span className={cn("tabular shrink-0 whitespace-nowrap", className)}>{text}</span>
}
