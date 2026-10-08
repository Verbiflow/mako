import { useHarnessIdentity } from "@/lib/harness-label"
import { useEffect, useState, type ReactNode } from "react"
import { CompactionControl } from "./compaction-control"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatCost, formatTokens } from "@/lib/format"
import { harnessLabel } from "@/lib/harness-label"
import type { Capability, ContextBreakdown, ContextCategory, HarnessUsage, LiveSessionUsage, TokenCounts } from "@/lib/types"
import { cn } from "@/lib/utils"
import { acp, useAcp } from "@/state/acp"
import { descriptorFor } from "@/state/descriptors"
import { useThreads } from "@/state/threads"
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

const NO_USAGE: LiveSessionUsage = {}

/** What the meter can show, from what the harness declares it reports (`HarnessUsage`), never from what has arrived so far. */
function useDeclaredUsage(harness: string | undefined): HarnessUsage | undefined {
  return useThreads((state) => (harness ? descriptorFor(state, harness)?.usage : undefined))
}

const reports = (capability: Capability) => capability.state === "implemented"

/** The fill, once a harness that reports it has: `undefined` before its first reading. */
function fractionOf(usage: LiveSessionUsage): number | undefined {
  return usage.used !== undefined && usage.size ? usage.used / usage.size : undefined
}

/**
 * How full the running session's context is, beside the send button, as the
 * harness declares it reports usage: a ring for one that reports the fill
 * (its track alone until the first reading), a dashed ring for one that
 * reports only what it spent (Cursor), nothing for one that reports neither.
 * The popover itemizes what the harness itemizes and says why anything it
 * doesn't report is missing.
 */
export function ContextMeter() {
  const scope = useConversationScope()
  const usage = useAcp((state) => scopedLiveAcp(state, scope)?.session.usage) ?? NO_USAGE
  const harness = useAcp((state) => scopedLiveAcp(state, scope)?.harness)
  const conversationId = useAcp((state) => scopedLiveAcp(state, scope)?.session.id)
  const declared = useDeclaredUsage(harness)
  const [open, setOpen] = useState(false)
  if (!harness || !conversationId || !declared) return null
  const measures = reports(declared.context)
  if (!measures && !reports(declared.tokens) && !reports(declared.cost)) return null
  const fraction = measures ? fractionOf(usage) : undefined
  const stale = declared.compaction.state === "default" && usage.compacted === true
  const summary = !measures
    ? "Context fill not reported"
    : fraction === undefined
      ? "Context measured after the first reply"
      : `Context ${Math.round(fraction * 100)}% full${stale ? ", compacted since" : ""}`
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
              {measures ? <Ring fraction={fraction} compacted={stale} /> : <UnmeasuredRing />}
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

/** The fill against its track; the track alone before the first reading. */
function Ring({ fraction, compacted }: { fraction: number | undefined; compacted: boolean }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const shown = fraction === undefined ? 0 : Math.min(1, Math.max(0.03, fraction))
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 -rotate-90", compacted && "opacity-50")} aria-hidden data-context-ring>
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-foreground/12" />
      {fraction === undefined ? null : <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="butt"
        strokeDasharray={`${shown * circumference} ${circumference}`}
        className={cn("transition-[stroke-dasharray] duration-500 ease-out", STROKE[toneOf(fraction)])}
      />}
    </svg>
  )
}

/** The ring's place for a harness that declares no fill: dashed, so it cannot read as an empty context. */
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
  const declared = useDeclaredUsage(harness)
  const itemizes = declared ? reports(declared.contextBreakdown) : false
  const breakdown = useBreakdown(conversationId, usage.used, itemizes)
  if (!declared) return null
  const measures = reports(declared.context)
  const fraction = measures ? fractionOf(usage) : undefined
  const stale = declared.compaction.state === "default" && usage.compacted === true
  return (
    <div className="flex flex-col" data-usage-details>
      <section className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ui">Context</span>
          <span className="text-label text-faint tabular-nums">
            {fraction !== undefined ? `${Math.round(fraction * 100)}%` : measures ? "After the first reply" : "Not reported"}
          </span>
        </div>
        {fraction !== undefined && usage.used !== undefined && usage.size ? (
          <>
            <ContextBar fraction={fraction} breakdown={breakdown} />
            <span className="text-label text-faint tabular-nums">
              {formatTokens(usage.used)} of {formatTokens(usage.size)} tokens
              {stale ? " before compacting. The next reply updates this." : ""}
            </span>
          </>
        ) : (
          <span className="text-label text-faint" data-context-unmeasured>
            {measures ? `${harnessLabel(harness)} reports how full the context is after each reply.` : absentReason(declared.context)}
          </span>
        )}
      </section>
      {breakdown ? <Categories breakdown={breakdown} /> : null}
      {reports(declared.tokens) || reports(declared.cost) ? <Spent usage={usage} declared={declared} harness={harness} /> : null}
      <div className="border-t border-hairline p-1">
        <CompactionControl onStart={onCompact} />
      </div>
    </div>
  )
}

/** A harness that declares a breakdown itemizes its context on request; asked once each time the popover opens and the reading moves. */
function useBreakdown(conversationId: string, used: number | undefined, itemizes: boolean): ContextBreakdown | null {
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null)
  useEffect(() => {
    if (!itemizes) return
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
  }, [conversationId, used, itemizes])
  return itemizes ? breakdown : null
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

/** A declared-absent capability's reason, which the declaration guarantees. */
function absentReason(capability: Capability): string | undefined {
  return capability.state === "absent" ? capability.reason : undefined
}

/** What the session spent, in what the harness declares it reports; a field it doesn't report says why. */
function Spent({ usage, declared, harness }: { usage: LiveSessionUsage; declared: HarnessUsage; harness: string }) {
  const tokens = reports(declared.tokens) ? usage.tokens : undefined
  const shownCost = reports(declared.cost) && usage.cost && usage.cost.amount > 0 ? usage.cost : undefined
  const unrecorded = reports(declared.missedCalls) ? usage.unrecorded : undefined
  const missed = tokens && unrecorded?.tokens
    ? `${harnessLabel(harness)} left some calls out of its usage count, so these totals may be low.`
    : shownCost && unrecorded?.cost
      ? `${harnessLabel(harness)} didn't report the cost of every call, so the cost may be low.`
      : undefined
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
      {shownCost ? (
        <Row label="Cost" value={shownCost.currency === "USD" ? formatCost(shownCost.amount) : `${shownCost.amount} ${shownCost.currency}`} strong />
      ) : null}
      {!tokens && !shownCost ? <span className="text-label text-faint">Counted after the first reply.</span> : null}
      {missed ? <span className="mt-0.5 text-label text-faint" data-unrecorded-spend>{missed}</span> : null}
      {tokens && !reports(declared.cost) ? <span className="mt-0.5 text-label text-faint" data-cost-unreported>{absentReason(declared.cost)}</span> : null}
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
