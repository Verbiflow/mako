import { useHarnessIdentity } from "@/lib/harness-label"
import { useEffect, useState, type ReactNode } from "react"
import { CompactionControl } from "./compaction-control"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatCost, formatTokens } from "@/lib/format"
import { harnessLabel } from "@/lib/harness-label"
import type { ContextBreakdown, ContextCategory, LiveSessionUsage, TokenCounts } from "@/lib/types"
import { cn } from "@/lib/utils"
import { acp, useAcp } from "@/state/acp"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"

type Tone = "neutral" | "caution" | "negative"

function toneOf(fraction: number): Tone {
  if (fraction >= 0.9) return "negative"
  if (fraction >= 0.75) return "caution"
  return "neutral"
}

const STROKE = {
  neutral: "stroke-foreground/55",
  caution: "stroke-caution",
  negative: "stroke-negative",
} satisfies Record<Tone, string>

const FILL = {
  neutral: "bg-foreground/55",
  caution: "bg-caution",
  negative: "bg-negative",
} satisfies Record<Tone, string>

/** Used categories, largest first, in steps of one ink so the bar reads as one thing. */
const INK = ["bg-foreground/75", "bg-foreground/55", "bg-foreground/40", "bg-foreground/28", "bg-foreground/20", "bg-foreground/14"]

/**
 * How full the running session's context is, beside the send button: a ring
 * when the harness reports the fill, a dashed ring when it reports only the
 * tokens spent (Cursor), nothing when it reports neither. The popover itemizes
 * what the harness itemizes and says plainly what it does not report.
 */
export function ContextMeter() {
  const scope = useConversationScope()
  const usage = useAcp((state) => scopedLiveAcp(state, scope)?.session.usage)
  const harness = useAcp((state) => scopedLiveAcp(state, scope)?.harness)
  const conversationId = useAcp((state) => scopedLiveAcp(state, scope)?.session.id)
  const [open, setOpen] = useState(false)
  if (!usage || !harness || !conversationId) return null
  const fraction = usage.used !== undefined && usage.size ? usage.used / usage.size : undefined
  const spent = usage.tokens ? total(usage.tokens) : undefined
  if (fraction === undefined && spent === undefined) return null
  const summary = fraction !== undefined
    ? `Context ${Math.round(fraction * 100)}% full${usage.compacted ? ", compacted since" : ""}`
    : "Context usage unavailable"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={summary}
              data-context-meter
              className="pressable flex size-8 shrink-0 items-center justify-center rounded-none text-faint hover:bg-fill-hover hover:text-foreground focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"
            >
              {fraction !== undefined ? (
                <Ring fraction={fraction} compacted={usage.compacted === true} />
              ) : (
                <UnmeasuredRing />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{summary}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-80 p-0">
        <UsageDetails usage={usage} harness={harness} conversationId={conversationId} onCompact={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function Ring({ fraction, compacted }: { fraction: number; compacted: boolean }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const shown = Math.min(1, Math.max(0.03, fraction))
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 -rotate-90", compacted && "opacity-50")} aria-hidden>
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-foreground/12" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="butt"
        strokeDasharray={`${shown * circumference} ${circumference}`}
        className={cn("transition-[stroke-dasharray] duration-500 ease-out", STROKE[toneOf(fraction)])}
      />
    </svg>
  )
}

/** The ring's place for a harness that reports spend but no fill: dashed, so it cannot read as an empty context. */
function UnmeasuredRing() {
  const radius = 6
  const dash = (2 * Math.PI * radius) / 12
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden data-unmeasured-ring>
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeDasharray={`${dash * 0.55} ${dash * 0.45}`}
        className="stroke-foreground/30"
      />
    </svg>
  )
}

/** The popover's body; also what the conversation menu showed before the meter moved here. */
export function UsageDetails({
  usage,
  harness,
  conversationId,
  onCompact,
}: {
  usage: LiveSessionUsage
  harness: string
  conversationId: string
  onCompact?: () => void
}) {
  useHarnessIdentity()
  const breakdown = useBreakdown(conversationId, usage.used)
  const fraction = usage.used !== undefined && usage.size ? usage.used / usage.size : undefined
  return (
    <div className="flex flex-col" data-usage-details>
      <section className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ui">Context</span>
          <span className="text-label text-faint tabular-nums">
            {fraction !== undefined ? `${Math.round(fraction * 100)}%` : "Unavailable"}
          </span>
        </div>
        {fraction !== undefined && usage.used !== undefined && usage.size ? (
          <>
            <ContextBar fraction={fraction} breakdown={breakdown} />
            <span className="text-label text-faint tabular-nums">
              {formatTokens(usage.used)} of {formatTokens(usage.size)} tokens
              {usage.compacted ? " before compacting. The next reply updates this." : ""}
            </span>
          </>
        ) : (
          <span className="text-label text-faint">
            {harnessLabel(harness)} doesn't report how full the context is.
          </span>
        )}
      </section>
      {breakdown ? <Categories breakdown={breakdown} /> : null}
      {usage.tokens || usage.cost ? <Spent tokens={usage.tokens} cost={usage.cost} /> : null}
      <div className="border-t border-hairline p-1">
        <CompactionControl onStart={onCompact} />
      </div>
    </div>
  )
}

/** Claude itemizes its context on request; asked once each time the popover opens and the reading moves. */
function useBreakdown(conversationId: string, used: number | undefined): ContextBreakdown | null {
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null)
  useEffect(() => {
    let current = true
    acp
      .contextBreakdown(conversationId)
      .then((value) => {
        if (current) setBreakdown(value)
      })
      .catch(() => {
        if (current) setBreakdown(null)
      })
    return () => {
      current = false
    }
  }, [conversationId, used])
  return breakdown
}

function ContextBar({ fraction, breakdown }: { fraction: number; breakdown: ContextBreakdown | null }) {
  const used = breakdown ? usedCategories(breakdown) : []
  if (!breakdown || !used.length)
    return (
      <span className="flex h-1.5 w-full overflow-hidden bg-raised">
        <span
          className={cn("h-full transition-[width] duration-500 ease-out", FILL[toneOf(fraction)])}
          style={{ width: `${Math.min(100, fraction * 100)}%` }}
        />
      </span>
    )
  const buffer = breakdown.categories.find((category) => category.kind === "buffer")
  return (
    <span className="flex h-1.5 w-full gap-px overflow-hidden bg-raised">
      {used.map((category, index) => (
        <span
          key={category.name}
          title={`${category.name}: ${formatTokens(category.tokens)}`}
          className={cn("h-full transition-[width] duration-500 ease-out", INK[Math.min(index, INK.length - 1)])}
          style={{ width: `${(category.tokens / breakdown.size) * 100}%` }}
        />
      ))}
      {buffer ? (
        <span
          title={`${buffer.name}: ${formatTokens(buffer.tokens)}`}
          className="ml-auto h-full bg-[repeating-linear-gradient(135deg,var(--color-foreground)_0_1px,transparent_1px_4px)] opacity-25"
          style={{ width: `${(buffer.tokens / breakdown.size) * 100}%` }}
        />
      ) : null}
    </span>
  )
}

function usedCategories(breakdown: ContextBreakdown): ContextCategory[] {
  return breakdown.categories.filter((category) => category.kind === "used").sort((a, b) => b.tokens - a.tokens)
}

const GROUP = {
  mcp: "MCP servers",
  memory: "Memory files",
  agents: "Agents",
  skills: "Skills",
} satisfies Record<ContextBreakdown["items"][number]["group"], string>

function Categories({ breakdown }: { breakdown: ContextBreakdown }) {
  const used = usedCategories(breakdown)
  const rest = breakdown.categories.filter((category) => category.kind !== "used")
  const groups = Object.entries(GROUP).flatMap(([group, label]) => {
    const items = breakdown.items.filter((item) => item.group === group)
    return items.length ? [{ label, items }] : []
  })
  return (
    <section className="flex flex-col gap-1 border-t border-hairline px-3 py-2.5" data-context-categories>
      {used.map((category, index) => (
        <Row key={category.name} label={category.name} value={formatTokens(category.tokens)}>
          <span className={cn("size-2 shrink-0", INK[Math.min(index, INK.length - 1)])} />
        </Row>
      ))}
      {rest.map((category) => (
        <Row key={category.name} label={category.name} value={formatTokens(category.tokens)} faint>
          <span
            className={cn(
              "size-2 shrink-0",
              category.kind === "buffer"
                ? "bg-[repeating-linear-gradient(135deg,var(--color-foreground)_0_1px,transparent_1px_3px)] opacity-40"
                : "bg-raised ring-1 ring-hairline"
            )}
          />
        </Row>
      ))}
      {groups.map((group) => (
        <div key={group.label} className="mt-1.5 flex flex-col gap-0.5">
          <span className="text-label text-faint">{group.label}</span>
          {group.items.map((item) => (
            <Row key={item.name} label={basename(item.name)} title={item.name} value={formatTokens(item.tokens)} faint />
          ))}
        </div>
      ))}
    </section>
  )
}

function Spent({ tokens, cost }: { tokens?: TokenCounts; cost?: LiveSessionUsage["cost"] }) {
  return (
    <section className="flex flex-col gap-1 border-t border-hairline px-3 py-2.5" data-session-spend>
      <span className="text-label text-faint">This session</span>
      {tokens ? (
        <>
          <Row label="Input" value={formatTokens(tokens.input)} />
          <Row label="Cache read" value={formatTokens(tokens.cacheRead)} />
          {tokens.cacheWrite ? <Row label="Cache write" value={formatTokens(tokens.cacheWrite)} /> : null}
          <Row
            label="Output"
            value={formatTokens(tokens.output)}
            detail={tokens.reasoning ? `${formatTokens(tokens.reasoning)} reasoning` : undefined}
          />
          <Row label="Total" value={formatTokens(total(tokens))} strong />
        </>
      ) : null}
      {cost && cost.amount > 0 ? (
        <Row label="Cost" value={cost.currency === "USD" ? formatCost(cost.amount) : `${cost.amount} ${cost.currency}`} strong />
      ) : null}
    </section>
  )
}

function Row({
  label,
  value,
  detail,
  title,
  faint,
  strong,
  children,
}: {
  label: string
  value: string
  detail?: string
  title?: string
  faint?: boolean
  strong?: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-label tabular-nums" title={title}>
      {children}
      <span className={cn("min-w-0 flex-1 truncate", faint ? "text-faint" : "text-muted-foreground", strong && "text-foreground")}>
        {label}
        {detail ? <span className="text-faint"> · {detail}</span> : null}
      </span>
      <span className={cn(faint ? "text-faint" : "text-muted-foreground", strong && "text-foreground")}>{value}</span>
    </div>
  )
}

function total(tokens: TokenCounts): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path
}
