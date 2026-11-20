import { askWords, childLine, childStateOf, openAsk } from "@mako/host/contracts/children"
import { placeDevice } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { memo } from "react"
import { useHarnessIdentity } from "@/lib/harness-label"
import { FinMark } from "@/components/stage/child-tabs"
import { useNeedsYouFins } from "@/state/fin-pips"
import { openFinInApex, useApexView, useFinOpenable, useThreadChildren } from "@/state/apex-fins"
import { cn } from "@/lib/utils"

/**
 * An Apex's Fins under its rail row, as Capy hangs a captain's crew: a 1 px line from the Apex's avatar and a square
 * elbow into each. Folded (the default) only the Fins that wait on the person show, each with its ask beside its
 * title; open, every Fin still in play shows, those that need the person first, then the finished as one line. A row
 * opens its Fin in place in the Apex's Thread, as the Agents panel does. The counts are the Apex's tip and Overview.
 */
export const ApexAsks = memo(function ApexAsks({ apex, apexTitle, open = false }: { apex: string | undefined; apexTitle: string; open?: boolean }) {
  const asking = useNeedsYouFins(apex)
  const all = useThreadChildren(open ? apex : undefined)
  if (!apex) return null
  const asks = new Set(asking.map((agent) => agent.nativeId))
  const live = open ? all.filter((agent) => !asks.has(agent.nativeId) && childStateOf(agent).kind !== "ended") : []
  const shown = [...asking, ...live]
  const finished = open ? all.filter((agent) => !asks.has(agent.nativeId) && childStateOf(agent).kind === "ended").length : 0
  if (!shown.length && !finished) return null
  return (
    <div data-apex-fins={apex} data-apex-fins-open={open || undefined}>
      {shown.map((agent, index) => (
        <FinRow key={agent.nativeId} apex={apex} apexTitle={apexTitle} agent={agent} needs={asks.has(agent.nativeId)} last={index === shown.length - 1 && !finished} />
      ))}
      {finished ? (
        <div data-fins-finished={finished} className="relative flex h-7 items-center pl-[52px] text-label text-faint">
          <span aria-hidden className="rail-branch" data-last />
          {finished} finished
        </div>
      ) : null}
    </div>
  )
})

/** What a row says of a Fin this window can't open: it runs on a device whose row isn't here. */
export const NOT_OPENABLE = "Not openable from here: it runs on another device, and its Thread isn't listed yet"

const FinRow = memo(function FinRow({ apex, apexTitle, agent, needs, last }: { apex: string; apexTitle: string; agent: NativeAgent; needs: boolean; last: boolean }) {
  useHarnessIdentity()
  const thread = agent.child?.thread
  const lit = useApexView((state) => thread !== undefined && state.open?.child === thread)
  const state = childStateOf(agent)
  // A Fin on another device whose row this window doesn't hold opens nothing: the row says so.
  const openable = useFinOpenable(agent)
  // A Fin on another device says which, in its tip, as its row there would.
  const where = agent.child?.place ? placeDevice(agent.child.place) : undefined
  const ask = openAsk(state)
  const line = ask ? askWords(ask) : childLine(state)
  return (
    <button
      type="button"
      data-asking-fin={needs ? thread : undefined}
      data-fin-row={thread}
      data-fin-place={where}
      data-active={lit || undefined}
      data-openable={openable}
      aria-disabled={openable ? undefined : true}
      aria-label={[agent.title, needs ? "needs you" : undefined, line, where ? `on ${where}` : undefined].filter(Boolean).join(", ")}
      data-tip={[agent.title, needs ? `Needs you${line ? `: ${line}` : ""}` : line, where ? `On ${where}` : undefined, openable ? undefined : NOT_OPENABLE].filter(Boolean).join("\n")}
      onClick={() => openFinInApex(apex, apexTitle, agent)}
      className={cn(
        "rail-calm group relative flex h-7 w-full items-center gap-2 pr-1.5 pl-[30px] text-left transition-colors duration-100 hover:bg-fill-hover data-active:bg-raised data-active:hover:bg-raised",
        !openable && "cursor-default opacity-60 hover:bg-transparent",
      )}
    >
      <span aria-hidden className="rail-branch" data-last={last || undefined} />
      <FinMark agent={agent} state={state} lit={lit} cut={lit ? "var(--raised)" : undefined} size={16} />
      <span data-asking-title className={cn("rail-fade min-w-0 flex-1 text-ui", lit ? "font-medium text-foreground" : needs ? "text-foreground" : "text-foreground/65")}>
        {agent.title}
      </span>
      {/* What it needs, beside its name: "Needs you" is never the whole of it, and the fin already says it needs you. */}
      {needs && line ? <span data-asking-line className="max-w-[48%] shrink truncate text-label text-faint">{line}</span> : null}
    </button>
  )
})
