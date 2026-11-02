import { memo, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRightIcon } from "lucide-react"
import { childGroup, childLine, childStateOf, childWord, threadsWord, type ChildGroup } from "@mako/host/contracts/children"
import { ROLE_WORD } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ChildStatusMark } from "@/components/stage/child-tabs"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { LeadMark } from "@/components/ui/lead-mark"
import { useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { acp, acpStore } from "@/state/acp"
import { threadChildren, useThreadChildren } from "@/state/lead-children"
import { Elapsed } from "@/components/inspector/elapsed"

const HEADINGS = {
  needs: "Needs you",
  working: "Working",
  queued: "Queued",
  failed: "Failed",
  done: "Done",
} satisfies Record<ChildGroup, string>

type Row = { kind: "heading"; group: ChildGroup; count: number } | { kind: "child"; agent: NativeAgent }

/**
 * A lead's Threads in its Agents panel, above what its harness runs in the
 * turn: what needs the person, then at work, queued, failed and done, one
 * strip each. Rows are drawn as they scroll into the panel, so a lead of a
 * thousand costs what a screenful does.
 */
export function LeadChildrenSection({
  children,
  conversation,
  leadTitle,
  scroller,
  open,
  onOpen,
}: {
  children: readonly NativeAgent[]
  conversation: string | undefined
  leadTitle: string
  scroller: RefObject<HTMLDivElement | null>
  open?: string
  onOpen?: (agent: NativeAgent) => void
}) {
  const section = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  const rows = useMemo(() => {
    const out: Row[] = []
    let group: ChildGroup | undefined
    let heading: Extract<Row, { kind: "heading" }> | undefined
    for (const agent of children) {
      const next = childGroup(childStateOf(agent))
      if (next !== group) {
        group = next
        heading = { kind: "heading", group: next, count: 0 }
        out.push(heading)
      }
      heading!.count += 1
      out.push({ kind: "child", agent })
    }
    return out
  }, [children])
  useLayoutEffect(() => {
    if (section.current) setMargin(section.current.offsetTop)
  }, [])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (rows[index]?.kind === "heading" ? 28 : 60),
    overscan: 8,
    scrollMargin: margin,
    getItemKey: (index) => {
      const row = rows[index]
      return row?.kind === "heading" ? `heading:${row.group}` : row ? `child:${row.agent.nativeId}` : index
    },
  })
  const stoppable = children.filter((agent) => agent.stoppable).length
  const stopAll = () => {
    if (!conversation) return
    const thread = acpStore.get().conversations[conversation]?.threadId
    for (const agent of threadChildren(acpStore.get(), thread)) if (agent.stoppable) void acp.stopAgent(conversation, agent.nativeId)
  }
  return (
    <section data-lead-children={children.length} aria-label={`${leadTitle}'s Threads`} className="mb-2">
      <div className="flex h-7 items-center gap-1.5 px-2.5 text-label text-faint">
        <LeadMark className="size-3" />
        <span className="min-w-0 truncate text-muted-foreground">{leadTitle}'s Threads</span>
        <span className="tabular shrink-0">· {children.length}</span>
        {stoppable && conversation ? (
          <button
            type="button"
            onClick={stopAll}
            title={`Stop ${threadsWord(stoppable)} under ${leadTitle}; the ${ROLE_WORD} keeps running`}
            className="pressable ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground"
          >
            Stop all
          </button>
        ) : null}
      </div>
      <div ref={section} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
            >
              {row.kind === "heading" ? (
                <div data-child-group={row.group} className="flex h-7 items-end gap-1.5 px-2.5 pb-1 text-label text-faint">
                  <span className={row.group === "needs" ? "text-caution" : undefined}>{HEADINGS[row.group]}</span>
                  <span className="tabular">{row.count}</span>
                </div>
              ) : (
                <ChildRow agent={row.agent} onOpen={onOpen} lit={row.agent.child?.thread === open} />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** One child as a strip: harness, name, state and time, then its question or phase, then what it runs as. Memoized on its entry. */
const ChildRow = memo(function ChildRow({ agent, onOpen, nested = false, lit = false }: { agent: NativeAgent; onOpen?: (agent: NativeAgent) => void; nested?: boolean; lit?: boolean }) {
  useHarnessIdentity()
  const state = childStateOf(agent)
  const group = childGroup(state)
  const line = childLine(state)
  const facts = [
    harnessLabel(agent.provider),
    agent.model,
    agent.role === ROLE_WORD ? ROLE_WORD : undefined,
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} ${agent.usage.toolUses === 1 ? "tool use" : "tool uses"}` : undefined,
  ].filter(Boolean)
  return (
    <div className={cn("contain-turn", nested && "ml-5")}>
      <button
        type="button"
        data-child-row={agent.child?.thread}
        data-child-state={state.kind}
        aria-current={lit || undefined}
        onClick={() => onOpen?.(agent)}
        className={cn("pressable flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-fill-hover", lit && "bg-fill-selected")}
      >
        <span className="flex h-5 shrink-0 items-center">
          <HarnessIcon harness={agent.provider} className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{agent.title}</span>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-label", group === "needs" ? "text-caution" : group === "failed" ? "text-negative" : "text-faint")}>
              {childWord(state)}
              <Elapsed agent={agent} />
            </span>
            <ChildStatusMark state={state} read />
          </span>
          {line && state.kind !== "queued" && state.kind !== "starting" ? <span className="line-clamp-2 text-ui leading-snug text-muted-foreground">{line}</span> : null}
          <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-label text-faint">
            {facts.map((fact, index) => (
              <span key={`${index}:${fact}`}>
                {index > 0 ? <span aria-hidden className="mr-1.5 text-faint/50">·</span> : null}
                {fact}
              </span>
            ))}
          </span>
        </span>
      </button>
      {agent.role === ROLE_WORD && agent.child ? <SubLeadFold thread={agent.child.thread} onOpen={onOpen} /> : null}
    </div>
  )
})

/** A child that leads its own: its Threads fold under it, closed until asked, counted as its badge counts them. */
function SubLeadFold({ thread, onOpen }: { thread: string; onOpen?: (agent: NativeAgent) => void }) {
  const children = useThreadChildren(thread)
  const [open, setOpen] = useState(false)
  if (!children.length) return null
  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="pressable ml-[2.375rem] flex items-center gap-1 rounded-md px-1.5 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
        <LeadMark className="size-3" />
        {threadsWord(children.length)}
      </button>
      {open ? children.map((agent) => <ChildRow key={agent.nativeId} agent={agent} onOpen={onOpen} nested />) : null}
    </div>
  )
}

