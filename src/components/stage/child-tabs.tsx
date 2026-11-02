import { memo, useCallback, useLayoutEffect, useRef, useState } from "react"
import { childGroup, childLine, childStateOf, childWord, rollup, threadsWord } from "@mako/host/contracts/children"
import type { ChildState } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { ThreadStatusMark } from "@/components/rail/thread-status"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { LeadMark } from "@/components/ui/lead-mark"
import { useHarnessIdentity, harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { openChildInLead, useLeadView, useThreadChildren } from "@/state/lead-children"
import { stage } from "@/state/stage"

/** A child tab's widths: narrower than a Session's, so a lead's Threads read as its own work beside them; they give way to the narrowest before one goes behind "+N". */
const CHILD_TAB_PX = 160
const CHILD_TAB_MIN_PX = 96
const GAP_PX = 6
/** The "+N" that stands for the rest at the strip's end. */
const MORE_PX = 40

/** Queued: started by no one yet, so a dashed ring where the others wear a mark. */
function QueuedMark({ label }: { label: string }) {
  return (
    <span role="img" aria-label={label} title={label} className="flex size-5 shrink-0 items-center justify-center">
      <span aria-hidden className="size-2 rounded-full border border-dashed border-faint" />
    </span>
  )
}

/**
 * A child's state in the rail's own marks, so its tab reads as a Session tab
 * does: what needs the person, running, failed, an answer to read, or queued.
 * An idle or stopped child has no news, so no mark.
 */
export function ChildStatusMark({ state, read }: { state: ChildState; read?: boolean }) {
  const line = childLine(state)
  const group = childGroup(state)
  if (group === "queued") return <QueuedMark label={line ?? childWord(state)} />
  if (group === "needs") return <ThreadStatusMark status={{ kind: "needs-permission", since: 0, detail: `${childWord(state)}: ${line ?? ""}` }} />
  if (group === "working") return <ThreadStatusMark status={{ kind: "working", since: 0, detail: line ?? childWord(state) }} />
  if (group === "failed") return <ThreadStatusMark status={{ kind: "failed", at: 0, detail: line ?? "Failed" }} />
  if (state.kind === "ended" && state.outcome === "done" && !read) return <ThreadStatusMark status={{ kind: "review", at: 0, unread: true }} />
  return null
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
      <HarnessIcon harness={agent.provider} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate text-left">{agent.title}</span>
      <ChildStatusMark state={state} read={selected} />
    </button>
  )
})

/**
 * A lead's Threads in its own strip, after its Sessions: a hairline, their
 * count (which opens the Agents panel), then a tab each, what needs the person
 * first. As many as fit; the rest are one "+N" pinned at the end.
 */
export function LeadChildTabs({ thread, leadTitle }: { thread: string; leadTitle: string }) {
  const children = useThreadChildren(thread)
  const open = useLeadView((state) => (state.open?.lead === thread ? state.open.child : undefined))
  const region = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ alone: 4, beside: 3 })
  const hasChildren = children.length > 0
  // Stable, so a batch moving one child repaints that child's tab alone.
  const press = useCallback((agent: NativeAgent) => openChildInLead(thread, leadTitle, agent), [thread, leadTitle])
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
        data-lead-count={counts.total}
        onClick={() => stage.open("agents")}
        title={`${threadsWord(counts.total)} under ${leadTitle}, in the Agents panel`}
        className="pressable flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
      >
        <LeadMark className="size-3.5" />
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
            title={`${threadsWord(rest)} more under ${leadTitle}, in the Agents panel`}
            className="pressable ml-auto flex h-7 shrink-0 items-center rounded-md px-2 text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
          >
            <span className="tabular">+{rest}</span>
          </button>
        ) : null}
      </div>
    </>
  )
}
