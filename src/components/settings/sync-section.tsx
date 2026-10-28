import { useEffect } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import type { SyncStatus, SyncTier, SyncTierName } from "@mako/host/contracts/sync-status"
import { Action, Chip, Eyebrow, ListCard, ListCardRow, Meter } from "@/components/ui/kit"
import { syncStatus, useSyncStatus } from "@/state/sync-status"
import { formatDay, formatRelative } from "@/lib/format"
import { useThreads } from "@/state/thread-store"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const TIER_LABELS = {
  now: "Working now",
  day: "Today",
  week: "This week",
  month: "Earlier this month",
} satisfies Record<SyncTierName, string>

type Running = Extract<SyncStatus, { tiers: unknown }>

const CHIPS = {
  synced: { tone: "positive", label: "In sync" },
  syncing: { tone: "neutral", label: "Catching up" },
  paused: { tone: "caution", label: "Waiting for power" },
  failing: { tone: "negative", label: "Not all sent" },
} satisfies Record<Running["state"], { tone: "positive" | "neutral" | "caution" | "negative"; label: string }>

/**
 * What of this Mac is in the cloud: every Thread worked in within the last 30 days, whole, the newest first. Each
 * tier counts its Threads in the cloud (every Session readable on another device and its records there to continue
 * from), what's catching up, when the last one went, and what didn't, in the cloud's words with its correlation ID.
 */
export function SyncSection() {
  const status = useSyncStatus((state) => state.status)
  useEffect(() => syncStatus.watch(), [])
  return (
    <div className="flex flex-col gap-2" data-testid="sync-section">
      <Eyebrow>Sync</Eyebrow>
      <ListCard>
        <ListCardRow className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="text-ui font-medium">Your last 30 days, in the cloud</div>
            <p className="mt-0.5 max-w-[30rem] text-label leading-relaxed text-pretty text-muted-foreground">
              Every Thread you worked in during the last 30 days goes up whole: the one you're working in within seconds of each turn, then today's, this week's and the rest. Your other devices can read each one, and continue it, even while this Mac is off.
            </p>
          </div>
          <StateChip status={status} />
        </ListCardRow>
        {status && "tiers" in status ? (
          <>
            {status.tiers.filter((tier) => tier.sessions > 0).map((tier) => (
              <TierRow key={tier.tier} tier={tier} sending={status.sending > 0} />
            ))}
            {status.tiers.every((tier) => tier.sessions === 0) ? (
              <ListCardRow>
                <p className="text-label text-faint">No Threads in the last 30 days yet.</p>
              </ListCardRow>
            ) : null}
            <ListCardRow>
              <p className="text-label leading-relaxed text-faint">
                {footer(status)}
              </p>
            </ListCardRow>
          </>
        ) : (
          <ListCardRow>
            <p className="flex items-center gap-1.5 text-label text-faint">
              <Spinner className="size-3" />
              {status?.state === "starting" ? `Reading ${count(status.sessions, "Session")} on this Mac…` : "Reading what's on this Mac…"}
            </p>
          </ListCardRow>
        )}
      </ListCard>
      {status && "tiers" in status && status.failures.length ? <Failures status={status} /> : null}
    </div>
  )
}

function StateChip({ status }: { status: SyncStatus | undefined }) {
  if (!status || !("tiers" in status)) return null
  const chip = CHIPS[status.state]
  return (
    <Chip tone={chip.tone} className="shrink-0 whitespace-nowrap" data-sync-state={status.state}>
      {chip.label}
    </Chip>
  )
}

function TierRow({ tier, sending }: { tier: SyncTier; sending: boolean }) {
  const done = tier.inCloud === tier.sessions
  return (
    <ListCardRow className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-6" data-sync-tier={tier.tier}>
        <div className="min-w-0">
          <div className="text-ui font-medium">{TIER_LABELS[tier.tier]}</div>
          <p className="mt-0.5 truncate text-label text-faint">
            {count(tier.threads, "Thread")} · {count(tier.sessions, "Session")}
          </p>
        </div>
        <div className={cn("flex shrink-0 items-center gap-1.5 text-label tabular-nums", done ? "text-positive" : "text-muted-foreground")}>
          {done ? <CheckIcon className="size-3.5" /> : sending ? <Spinner className="size-3 text-faint" /> : null}
          {done ? `All ${count(tier.threads, "Thread")}` : `${tier.threadsInCloud} of ${count(tier.threads, "Thread")}`}
        </div>
      </div>
      {done ? null : (
        <>
          <Meter value={tier.sessions ? tier.inCloud / tier.sessions : 0} tone="positive" />
          <p className="text-label text-faint">{detail(tier)}</p>
        </>
      )}
    </ListCardRow>
  )
}

/** What's left of a tier, in the two forms a Session goes up in, and what this Mac still has to read first. */
function detail(tier: SyncTier): string {
  const parts = [
    tier.readable === tier.sessions ? "All readable on your other devices" : `${tier.readable} of ${tier.sessions} readable on your other devices`,
    tier.whole === tier.sessions ? "all ready to continue anywhere" : `${tier.whole} ready to continue anywhere`,
  ]
  const unread = tier.sessions - tier.held
  if (unread > 0) parts.push(`${unread} still being read on this Mac`)
  return parts.join(" · ")
}

function footer(status: Running): string {
  const parts: string[] = []
  if (status.state === "paused") parts.push("Catching up waits while this Mac is on a low battery or in Low Power Mode; the Thread you're working in still goes up.")
  parts.push(status.lastSuccessAt ? `Last sent ${ago(status.lastSuccessAt)}.` : "Nothing sent yet.")
  if (status.stale > 0) parts.push(`${count(status.stale, "Session")} changed since ${status.stale === 1 ? "its" : "their"} last copy, going up in turn.`)
  const backfill = status.backfill
  if (backfill && backfill.endedAt === undefined && backfill.done < backfill.sessions)
    parts.push(`Reading this Mac's older sessions into its records: ${backfill.done.toLocaleString()} of ${backfill.sessions.toLocaleString()}.`)
  return parts.join(" ")
}

function Failures({ status }: { status: Running }) {
  const names = useThreads((state) => state.descriptors)
  const [first] = status.failures
  if (!first) return null
  const name = (harness: string) => names.find((entry) => entry.provider === harness)?.displayName ?? harness
  const details = status.failures
    .map((failure) => [new Date(failure.at).toISOString(), failure.harness, failure.nativeId, failure.correlationId ?? "-", failure.message].join("\t"))
    .join("\n")
  return (
    <div role="alert" className="flex items-start justify-between gap-4 rounded-lg bg-negative/8 px-3 py-2 ring-1 ring-negative/20 ring-inset" data-sync-failures>
      <div className="min-w-0 text-ui leading-relaxed text-negative">
        {status.failures.length === 1
          ? `A ${name(first.harness)} session didn't go up ${ago(first.at)}. Mako tries again on its own.`
          : `${status.failures.length} Sessions didn't go up, the last ${ago(first.at)}. Mako tries again on its own.`}
        <p className="mt-0.5 truncate text-label opacity-80" title={first.message}>
          {first.message}
        </p>
      </div>
      <Action tone="outline" size="xs" className="shrink-0" onClick={() => copy(details)}>
        <CopyIcon />
        Copy details
      </Action>
    </div>
  )
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`
}

/** "just now", "12m ago", "3h ago", or the day. */
function ago(at: number): string {
  const relative = formatRelative(at)
  if (relative === "now") return "just now"
  return /^\d/.test(relative) ? `${relative} ago` : `on ${relative || formatDay(at)}`
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast("Details copied"),
    () => toast.error("The details weren't copied")
  )
}
