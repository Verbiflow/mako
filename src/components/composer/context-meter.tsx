import { useHarnessIdentity } from "@/lib/harness-label"
import { useEffect, useState, type ReactNode } from "react"
import { CompactionControl } from "./compaction-control"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatCost, formatTokens } from "@/lib/format"
import { harnessLabel } from "@/lib/harness-label"
import type { Capability, ContextBreakdown, ContextCategory, HarnessUsage, LiveRequest, LiveSessionUsage, TokenCounts } from "@/lib/types"
import { useThreadChanges } from "@/state/thread-changes"
import { conversationSpend, PRICE_TABLES, type ChangeCounts, type ConversationSpend, type TurnSpend } from "@mako/host/contracts/usage-ledger"
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
const NO_REQUESTS: readonly LiveRequest[] = []

/** What the meter can show, from what the harness declares it reports (`HarnessUsage`), never from what has arrived so far. */
function useDeclaredUsage(harness: string | undefined): HarnessUsage | undefined {
  return useThreads((state) => (harness ? descriptorFor(state, harness)?.usage : undefined))
}

const reports = (capability: Capability) => capability.state === "implemented"

/** The fill, once a harness that reports it has: `undefined` before its first reading and after a compaction it didn't measure. */
function fractionOf(usage: LiveSessionUsage): number | undefined {
  return usage.used !== undefined && usage.size ? usage.used / usage.size : undefined
}

/** A compaction the harness didn't measure: what it held before, until the next reply measures again. */
function compactedFrom(usage: LiveSessionUsage): number | undefined {
  return usage.used === undefined ? usage.compactedFrom : undefined
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
  const compacted = measures && compactedFrom(usage) !== undefined
  const summary = !measures
    ? "Context fill not reported"
    : compacted
      ? "Context compacted, measured after the next reply"
      : fraction === undefined
        ? "Context measured after the first reply"
        : `Context ${Math.round(fraction * 100)}% full`
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
              {measures ? <Ring fraction={fraction} compacted={compacted} /> : <UnmeasuredRing />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{summary}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-80 p-0">
        <ConversationUsageDetails usage={usage} harness={harness} conversationId={conversationId} onCompact={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The fill against its track; the track alone before the first reading, and
 * after a compaction the harness didn't measure, when a dot marks that the
 * context did change.
 */
function Ring({ fraction, compacted }: { fraction: number | undefined; compacted: boolean }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const shown = fraction === undefined ? 0 : Math.min(1, Math.max(0.03, fraction))
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden data-context-ring data-context-compacted={compacted || undefined}>
      {compacted ? <circle cx="8" cy="8" r="1.5" className="fill-foreground/55" /> : null}
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

/** The popover's body for the conversation in scope: its context reading and the requests whose spend it sums. */
function ConversationUsageDetails(props: { usage: LiveSessionUsage; harness: string; conversationId: string; onCompact?: () => void }) {
  const scope = useConversationScope()
  const requests = useAcp((state) => scopedLiveAcp(state, scope)?.requests) ?? NO_REQUESTS
  const sideQuestions = useAcp((state) => scopedLiveAcp(state, scope)?.side?.exchanges.length ?? 0)
  const thread = useAcp((state) => scopedLiveAcp(state, scope)?.threadId)
  const changes = useThreadChanges(thread, requests.length)
  return <UsageDetails {...props} requests={requests} sideQuestions={sideQuestions} changes={changes} />
}

/**
 * The popover's body: what the context holds now, what this conversation
 * spent turn by turn, and the harness's own total for its session. Three
 * numbers for three questions, each read only where the harness declares it.
 */
export function UsageDetails({
  usage,
  harness,
  conversationId,
  requests,
  sideQuestions = 0,
  changes,
  onCompact,
}: {
  usage: LiveSessionUsage
  harness: string
  conversationId: string
  requests: readonly LiveRequest[]
  /** Side questions asked beside the conversation: their spend is the harness's, outside its turns. */
  sideQuestions?: number
  /** What the conversation's turns changed, once the attribution journal counts it; nothing is shown without it. */
  changes?: ChangeCounts
  onCompact?: () => void
}) {
  useHarnessIdentity()
  const declared = useDeclaredUsage(harness)
  const itemizes = declared ? reports(declared.contextBreakdown) : false
  const breakdown = useBreakdown(conversationId, usage.used, itemizes)
  if (!declared) return null
  const measures = reports(declared.context)
  const fraction = measures ? fractionOf(usage) : undefined
  const before = measures ? compactedFrom(usage) : undefined
  const spend = conversationSpend(requests, usage, harness)
  return (
    <div className="flex flex-col" data-usage-details>
      <section className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ui">Context</span>
          <span className="text-label text-faint tabular-nums">
            {fraction !== undefined ? `${Math.round(fraction * 100)}%` : before !== undefined ? "Compacted" : measures ? "After the first reply" : "Not reported"}
          </span>
        </div>
        {fraction !== undefined && usage.used !== undefined && usage.size ? (
          <>
            <ContextBar fraction={fraction} breakdown={breakdown} />
            <span className="text-label text-faint tabular-nums">
              {formatTokens(usage.used)} of {formatTokens(usage.size)} tokens in the window now
            </span>
          </>
        ) : before !== undefined && usage.size ? (
          <span className="text-label text-faint tabular-nums" data-context-compacted>
            Held {formatTokens(before)} of {formatTokens(usage.size)} tokens before compacting. {compactionReason(declared.compaction, harness)}
          </span>
        ) : (
          <span className="text-label text-faint" data-context-unmeasured>
            {measures ? `${harnessLabel(harness)} reports how full the context is after each reply.` : absentReason(declared.context)}
          </span>
        )}
      </section>
      {breakdown && fraction !== undefined ? <Categories breakdown={breakdown} /> : null}
      {reports(declared.tokens) || reports(declared.cost) ? <Spent spend={spend} declared={declared} harness={harness} sideQuestions={sideQuestions} changes={changes} /> : null}
      {usage.native ? <HarnessTotal native={usage.native} declared={declared} harness={harness} /> : null}
      <div className="border-t border-hairline p-1">
        <CompactionControl onStart={onCompact} />
      </div>
    </div>
  )
}

/** Why the meter waits after a compaction: the harness's own declaration, or the plain fact. */
function compactionReason(capability: Capability, harness: string): string {
  return capability.state === "default" ? capability.reason : `${harnessLabel(harness)} measures it again at the next reply.`
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

/**
 * What this conversation spent, summed from each turn's own record, so a
 * reopened conversation reads the same. A cost the harness reported and one
 * Mako estimated are separate rows: an estimate is marked and names its
 * price table, and neither is a bill.
 */
function Spent({ spend, declared, harness, sideQuestions, changes }: { spend: ConversationSpend; declared: HarnessUsage; harness: string; sideQuestions: number; changes?: ChangeCounts }) {
  const tokens = reports(declared.tokens) ? spend.tokens : undefined
  const cost = reports(declared.cost) && spend.cost ? spend.cost : undefined
  const estimate = spend.estimate && spend.estimate.amount > 0 ? spend.estimate : undefined
  const unrecorded = reports(declared.missedCalls) ? spend.unrecorded : undefined
  const missed = tokens && unrecorded?.tokens
    ? `${harnessLabel(harness)} left some calls out of its usage count, so these totals may be low.`
    : cost && unrecorded?.cost
      ? `${harnessLabel(harness)} didn't report the cost of every call, so the cost may be low.`
      : undefined
  const turns = spend.turns === 1 ? "1 turn" : `${spend.turns} turns`
  return (
    <section className="flex flex-col gap-1 border-t border-hairline px-3 py-2.5" data-session-spend>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label text-faint">Spent in this conversation</span>
        {spend.turns ? <span className="text-label text-faint tabular-nums">{spend.running ? `${turns}, one running` : turns}</span> : null}
      </div>
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
      {cost ? <Row label={`Cost, as ${harnessLabel(harness)} priced it`} value={formatCost(cost)} strong /> : null}
      {estimate ? (
        <Row
          label="Cost at API list prices"
          value={`≈ ${formatCost(estimate.amount)}`}
          title={estimateTitle(estimate.tables)}
          strong={!cost}
          data-cost-estimate
        />
      ) : null}
      {spend.last && spend.turns > 1 ? <LastTurn spend={spend.last} declared={declared} /> : null}
      {changes ? <Row label={changes.scope === "thread" ? "Changes made by the thread" : "Changes made"} value={`${changes.files === 1 ? "1 file" : `${changes.files} files`} · +${changes.added} −${changes.removed}`} title={changes.kinds ? kindsTitle(changes.kinds) : undefined} data-changes /> : null}
      {changes?.commands || changes?.outside ? (
        <span className="text-label text-faint tabular-nums" data-changes-beyond>
          {[changes.commands ? `${changes.commands} ${changes.commands === 1 ? "command" : "commands"} run` : "", changes.outside ? `${changes.outside} ${changes.outside === 1 ? "path" : "paths"} touched outside its checkouts` : ""].filter(Boolean).join(" · ")}
        </span>
      ) : null}
      {!tokens && !cost && !estimate ? <span className="text-label text-faint">Counted after the first reply.</span> : null}
      {missed ? <span className="mt-0.5 text-label text-faint" data-unrecorded-spend>{missed}</span> : null}
      {sideQuestions ? (
        <span className="mt-0.5 text-label text-faint" data-side-spend>
          {sideQuestions === 1 ? "The side question isn't" : `The ${sideQuestions} side questions aren't`} in these totals; {harnessLabel(harness)}&rsquo;s own records count {sideQuestions === 1 ? "it" : "them"}.
        </span>
      ) : null}
      {tokens && !reports(declared.cost) ? (
        <span className="mt-0.5 text-label text-faint" data-cost-unreported>
          {absentReason(declared.cost)}{estimate ? " The estimate is Mako's, from list prices." : ""}
        </span>
      ) : null}
    </section>
  )
}

/** The newest turn's spend in one line, so a costly turn stands out from the sum. */
function LastTurn({ spend, declared }: { spend: TurnSpend; declared: HarnessUsage }) {
  const parts = [
    reports(declared.tokens) && spend.tokens ? `${formatTokens(total(spend.tokens))} tokens` : undefined,
    reports(declared.cost) && spend.cost !== undefined ? formatCost(spend.cost) : spend.estimate ? `≈ ${formatCost(spend.estimate.amount)}` : undefined,
  ].filter(Boolean)
  return parts.length ? <Row label="Last turn" value={parts.join(" · ")} faint /> : null
}

/** The harness's own count for its native session, which outlives a process and counts turns outside Mako. */
function HarnessTotal({ native, declared, harness }: { native: NonNullable<LiveSessionUsage["native"]>; declared: HarnessUsage; harness: string }) {
  const tokens = reports(declared.tokens) ? total(native.tokens) : undefined
  if (!tokens && native.cost === undefined) return null
  return (
    <section className="flex flex-col gap-1 border-t border-hairline px-3 py-2.5" data-harness-total>
      <span className="text-label text-faint">{harnessLabel(harness)}&rsquo;s own count for this session</span>
      {tokens ? <Row label="Tokens" value={formatTokens(tokens)} /> : null}
      {native.cost !== undefined && reports(declared.cost) ? <Row label="Cost" value={formatCost(native.cost)} /> : null}
      <span className="text-label text-faint">It includes turns run outside Mako.</span>
    </section>
  )
}

/** The files a Thread changed, by what happened to each. */
function kindsTitle(kinds: NonNullable<ChangeCounts["kinds"]>): string {
  return [`${kinds.created} created`, `${kinds.changed} changed`, `${kinds.deleted} deleted`, `${kinds.renamed} renamed`].join(", ")
}

/** Where an estimate came from, in a sentence: the table's date and its sources. */
function estimateTitle(tables: readonly string[]): string {
  const sources = PRICE_TABLES.filter((table) => tables.includes(table.id)).flatMap((table) => table.sources)
  return `Estimated by Mako from API list prices read ${tables.join(", ")}${sources.length ? ` (${sources.join(", ")})` : ""}. Subscriptions and discounts aren't included, so this is not what you were billed.`
}

function Row({
  label,
  value,
  detail,
  title,
  faint,
  strong,
  children,
  ...data
}: {
  label: string
  value: string
  detail?: string
  title?: string
  faint?: boolean
  strong?: boolean
  children?: ReactNode
  "data-cost-estimate"?: boolean
  "data-changes"?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-label tabular-nums" title={title} {...data}>
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
