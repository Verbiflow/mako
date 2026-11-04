import { memo, useCallback, useLayoutEffect, useRef, useState } from "react"
import { childLine, childStateOf, childWord, rollup } from "@mako/host/contracts/children"
import { finsWord } from "@mako/host/contracts/agents"
import type { ChildState } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { LiveMark } from "@/components/ui/live-mark"
import { finMarkState, motionOf } from "@/lib/live-mark-state"
import { ApexMark } from "@/components/ui/apex-mark"
import { useHarnessIdentity, harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { openFinInApex, useApexView, useThreadChildren } from "@/state/apex-fins"
import { stage } from "@/state/stage"

/** A Fin tab's widths: narrower than a Session's, so an Apex's Fins read as its own work beside them; they give way to the narrowest before one goes behind "+N". */
const CHILD_TAB_PX = 160
const CHILD_TAB_MIN_PX = 96
const GAP_PX = 6
/** The "+N" that stands for the rest at the strip's end. */
const MORE_PX = 40

/**
 * A Fin's live mark: the plain fin doing what the Fin does, its harness a corner badge. A Fin that finished and
 * hasn't been read wears the unread dot.
 */
export function FinMark({ agent, state, read, lit, cut }: { agent: NativeAgent; state: ChildState; read?: boolean; lit?: boolean; cut?: string }) {
  const line = childLine(state)
  const unread = state.kind === "ended" && state.outcome === "done" && !read
  return (
    <LiveMark kind="fin" state={unread ? "unread" : finMarkState(state)} motion={motionOf(line)} lit={lit} cut={cut} label={line ? `${childWord(state)}: ${line}` : childWord(state)}>
      <HarnessIcon harness={agent.provider} />
    </LiveMark>
  )
}

/** One child's tab: its harness, its title and its state. Memoized on its entry, which keeps its identity while it's unchanged. */
const ChildTab = memo(function ChildTab({ agent, selected, onOpen }: { agent: NativeAgent; selected: boolean; onOpen: (agent: NativeAgent) => void }) {
  useHarnessIdentity()
  const state = childStateOf(agent)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-child-tab={agent.child?.thread}
      title={`${agent.title} · ${harnessLabel(agent.provider)} · ${childWord(state)}`}
      onMouseDown={(event) => {
        if (event.button === 0 && event.detail > 0) onOpen(agent)
      }}
      onClick={(event) => {
        if (event.detail === 0) onOpen(agent)
      }}
      style={{ flex: `0 1 ${CHILD_TAB_PX}px`, minWidth: CHILD_TAB_MIN_PX }}
      className={cn(
        "session-tab group relative flex h-7 items-center gap-1.5 overflow-hidden rounded-md pr-0.5 pl-1.5 text-ui",
        selected ? "bg-raised font-medium text-foreground" : "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      )}
    >
      <FinMark agent={agent} state={state} read={selected} lit={selected} cut={selected ? "var(--raised)" : "var(--shell)"} />
      <span className="min-w-0 flex-1 truncate text-left">{agent.title}</span>
    </button>
  )
})

/**
 * An Apex's Fins in its own strip, after its Sessions: a hairline, their
 * count (which opens the Agents panel), then a tab each, what needs the person
 * first. As many as fit; the rest are one "+N" pinned at the end.
 */
export function ApexFinTabs({ thread, apexTitle }: { thread: string; apexTitle: string }) {
  const children = useThreadChildren(thread)
  const open = useApexView((state) => (state.open?.apex === thread ? state.open.child : undefined))
  const region = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ alone: 4, beside: 3 })
  const hasChildren = children.length > 0
  // Stable, so a batch moving one Fin repaints that Fin's tab alone.
  const press = useCallback((agent: NativeAgent) => openFinInApex(thread, apexTitle, agent), [thread, apexTitle])
  useLayoutEffect(() => {
    const node = region.current
    if (!node) return
    const measure = (width: number) => {
      const alone = Math.max(1, Math.floor((width + GAP_PX) / (CHILD_TAB_MIN_PX + GAP_PX)))
      const beside = Math.max(1, Math.floor((width - MORE_PX) / (CHILD_TAB_MIN_PX + GAP_PX)))
      setFit((held) => (held.alone === alone && held.beside === beside ? held : { alone, beside }))
    }
    measure(node.clientWidth)
    const observer = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? node.clientWidth))
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasChildren])
  if (!hasChildren) return null
  const counts = rollup(children)
  const shown = children.slice(0, children.length <= fit.alone ? children.length : fit.beside)
  const opened = open ? children.find((agent) => agent.child?.thread === open) : undefined
  if (opened && !shown.includes(opened)) shown[shown.length - 1] = opened
  const rest = children.length - shown.length
  return (
    <>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hairline" />
      <button
        type="button"
        data-apex-count={counts.total}
        onClick={() => stage.open("agents")}
        title={`${finsWord(counts.total)} under ${apexTitle}, in the Agents panel`}
        className="pressable flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
      >
        <ApexMark className="size-3.5" />
        <span className="tabular">{counts.total}</span>
      </button>
      <div ref={region} data-child-tabs style={{ minWidth: CHILD_TAB_MIN_PX + GAP_PX + MORE_PX }} className="flex flex-1 items-center gap-1.5 overflow-hidden">
        {shown.map((agent) => (
          <ChildTab key={agent.nativeId} agent={agent} selected={open === agent.child?.thread} onOpen={press} />
        ))}
        {rest > 0 ? (
          <button
            type="button"
            data-child-more={rest}
            onClick={() => stage.open("agents")}
            title={`${finsWord(rest)} more under ${apexTitle}, in the Agents panel`}
            className="pressable ml-auto flex h-7 shrink-0 items-center rounded-md px-2 text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
          >
            <span className="tabular">+{rest}</span>
          </button>
        ) : null}
      </div>
    </>
  )
}
