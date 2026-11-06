import { childLine, childStateOf } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { memo } from "react"
import { useHarnessIdentity } from "@/lib/harness-label"
import { FinMark } from "@/components/stage/child-tabs"
import { useNeedsYouFins } from "@/state/fin-pips"
import { openFinInApex, useApexView } from "@/state/apex-fins"
import { cn } from "@/lib/utils"

/**
 * Under an Apex's rail row, each of its Fins that waits on the person, set in to the Apex's title and pips so the
 * indent is the branch (the rail draws no lines): its mark, its title and "Needs you". Every other Fin stays out of the rail; its state is in the Apex's pips. A row opens
 * its Fin in place in the Apex's Thread, as the Agents panel does. `indent` matches the Apex row's own inset.
 */
export const ApexAsks = memo(function ApexAsks({ apex, apexTitle, indent }: { apex: string | undefined; apexTitle: string; indent?: boolean }) {
  const fins = useNeedsYouFins(apex)
  if (!apex || !fins.length) return null
  return fins.map((agent) => <AskingFin key={agent.nativeId} apex={apex} apexTitle={apexTitle} agent={agent} indent={indent} />)
})

const AskingFin = memo(function AskingFin({ apex, apexTitle, agent, indent }: { apex: string; apexTitle: string; agent: NativeAgent; indent?: boolean }) {
  useHarnessIdentity()
  const thread = agent.child?.thread
  const lit = useApexView((state) => thread !== undefined && state.open?.child === thread)
  const state = childStateOf(agent)
  return (
    <button
      type="button"
      data-asking-fin={thread}
      data-active={lit || undefined}
      data-tip={[agent.title, childLine(state)].filter(Boolean).join("\n")}
      onClick={() => openFinInApex(apex, apexTitle, agent)}
      className={cn(
        "group relative flex h-7 w-full items-center gap-2 pr-1.5 text-left transition-colors duration-100 hover:bg-fill-hover data-active:bg-raised data-active:hover:bg-raised",
        indent ? "pl-9" : "pl-[34px]",
      )}
    >
      <FinMark agent={agent} state={state} lit={lit} cut={lit ? "var(--raised)" : undefined} />
      <span className={cn("min-w-0 flex-1 truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>{agent.title}</span>
      <span className="shrink-0 text-label font-medium text-attention">Needs you</span>
    </button>
  )
})
