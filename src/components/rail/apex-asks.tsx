import { childLine, childStateOf } from "@mako/host/contracts/children"
import { placeDevice } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { memo } from "react"
import { useHarnessIdentity } from "@/lib/harness-label"
import { FinMark } from "@/components/stage/child-tabs"
import { useNeedsYouFins } from "@/state/fin-pips"
import { openFinInApex, useApexView, useFinOpenable } from "@/state/apex-fins"
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

/** What a row says of a Fin this window can't open: it runs on a device whose row isn't here. */
export const NOT_OPENABLE = "Not openable from here: it runs on another device, and its Thread isn't listed yet"

const AskingFin = memo(function AskingFin({ apex, apexTitle, agent, indent }: { apex: string; apexTitle: string; agent: NativeAgent; indent?: boolean }) {
  useHarnessIdentity()
  const thread = agent.child?.thread
  const lit = useApexView((state) => thread !== undefined && state.open?.child === thread)
  const state = childStateOf(agent)
  // A Fin on another device whose row this window doesn't hold opens nothing: the row says so.
  const openable = useFinOpenable(agent)
  // A Fin on another device says which, as its row there would.
  const where = agent.child?.place ? placeDevice(agent.child.place) : undefined
  return (
    <button
      type="button"
      data-asking-fin={thread}
      data-active={lit || undefined}
      data-openable={openable}
      aria-disabled={openable ? undefined : true}
      data-tip={[agent.title, childLine(state), openable ? undefined : NOT_OPENABLE].filter(Boolean).join("\n")}
      onClick={() => openFinInApex(apex, apexTitle, agent)}
      className={cn(
        "group relative flex h-7 w-full items-center gap-2 pr-1.5 text-left transition-colors duration-100 hover:bg-fill-hover data-active:bg-raised data-active:hover:bg-raised",
        indent ? "pl-9" : "pl-[34px]",
        !openable && "cursor-default opacity-60 hover:bg-transparent",
      )}
    >
      <FinMark agent={agent} state={state} lit={lit} cut={lit ? "var(--raised)" : undefined} />
      <span className={cn("min-w-0 flex-1 truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>
        {agent.title}
        {where ? <span data-fin-place={where} className="text-label text-faint"> · {where}</span> : null}
      </span>
      <span className="shrink-0 text-label font-medium text-attention">Needs you</span>
    </button>
  )
})
