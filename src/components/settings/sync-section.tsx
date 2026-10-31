import { useEffect } from "react"
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { syncFailureWords, type SyncFailureView, type SyncStatus, type SyncTier, type SyncTierName } from "@mako/host/contracts/sync-status"
import { Action, Chip, Eyebrow, ListCard, ListCardRow, Meter } from "@/components/ui/kit"
import { syncStatus, useSyncStatus } from "@/state/sync-status"
import { formatDay, formatRelative, formatTime } from "@/lib/format"
import { useThreads } from "@/state/thread-store"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const TIER_LABELS = {
  now: "Working now",
  day: "Today",
  week: "This week",
} satisfies Record<SyncTierName, string>

type Running = Extract<SyncStatus, { tiers: unknown }>

const CHIPS = {
  synced: { tone: "positive", label: "In sync" },
  syncing: { tone: "neutral", label: "Catching up" },
  paused: { tone: "caution", label: "Waiting for power" },
  failing: { tone: "negative", label: "Not all sent" },
} satisfies Record<Running["state"], { tone: "positive" | "neutral" | "caution" | "negative"; label: string }>

/**
 * What of this Mac is in the cloud: every Thread worked in within the last 7 days, whole, the newest first. Each
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
            <div className="text-ui font-medium">Your last 7 days, in the cloud</div>
            <p className="mt-0.5 max-w-[30rem] text-label leading-relaxed text-pretty text-muted-foreground">
              Every Thread you worked in during the last 7 days goes up whole, the newest first: the one you're working in within seconds of each turn, then today's, then the rest of the week. Your other devices can read each one, and continue it, even while this Mac is off.
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
                <p className="text-label text-faint">No Threads in the last 7 days yet.</p>
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

/**
 * The Sessions not synced, as the sync daemon says (a failure that lasted, never one the next try healed): each in a
 * person's words, what Mako does next, and one disclosure away the account's own words with the correlation ID.
 */
function Failures({ status }: { status: Running }) {
  const name = useSessionName()
  const [first] = status.failures
  if (!first) return null
  const notSynced = status.notSynced ?? status.failures.length
  const details = status.failures.map(detailLine).join("\n")
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg bg-negative/8 px-3 py-2.5 ring-1 ring-negative/20 ring-inset" data-sync-failures>
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-ui font-medium text-negative">
          {notSynced === 1 ? `${name(first)} isn't synced` : `${count(notSynced, "Session")} aren't synced`}
        </p>
        <Action tone="outline" size="xs" className="shrink-0" onClick={() => copy(details)}>
          <CopyIcon />
          Copy details
        </Action>
      </div>
      {status.failures.map((failure) => {
        const words = syncFailureWords(failure.kind)
        return (
          <div key={`${failure.harness}:${failure.nativeId}`} className="min-w-0" data-sync-failure={failure.nativeId}>
            <p className="text-label text-foreground">
              {notSynced === 1 ? null : <span className="font-medium">{name(failure)}: </span>}
              {words.what} · since {sinceAt(failure.since ?? failure.at)}
            </p>
            <p className="text-label text-muted-foreground">{words.next}</p>
            <details className="group/failure mt-0.5">
              <summary className="pressable -mx-1 flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm px-1 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon aria-hidden className="size-3 shrink-0 transition-transform duration-150 ease-(--ease-out) group-open/failure:rotate-90" />
                Details
              </summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-4 text-label">
                <dt className="text-faint">The account said</dt>
                <dd className="min-w-0 break-words font-mono text-muted-foreground select-text">{failure.message}</dd>
                {failure.correlationId ? (
                  <>
                    <dt className="text-faint">Correlation</dt>
                    <dd className="min-w-0 truncate font-mono text-muted-foreground select-text">{failure.correlationId}</dd>
                  </>
                ) : null}
                <dt className="text-faint">Session</dt>
                <dd className="min-w-0 truncate font-mono text-muted-foreground select-text">{failure.harness} {failure.nativeId}</dd>
                <dt className="text-faint">Last tried</dt>
                <dd className="text-muted-foreground">{ago(failure.at)}</dd>
              </dl>
            </details>
          </div>
        )
      })}
      {notSynced > status.failures.length ? <p className="text-label text-faint">And {count(notSynced - status.failures.length, "more Session")}.</p> : null}
    </div>
  )
}

/** One failure for a report: when it began and was last tried, the Session, the correlation ID, the account's words. */
function detailLine(failure: SyncFailureView): string {
  return [new Date(failure.since ?? failure.at).toISOString(), new Date(failure.at).toISOString(), failure.kind ?? "-", failure.harness, failure.nativeId, failure.correlationId ?? "-", failure.message].join("\t")
}

/** A Session as the person knows it: its Thread's title where the rail lists it, else its harness's session. */
function useSessionName(): (failure: { harness: string; nativeId: string }) => string {
  const descriptors = useThreads((state) => state.descriptors)
  const threads = useThreads((state) => state.threads)
  return (failure) => {
    const title = threads.find((thread) => thread.harness === failure.harness && thread.nativeId === failure.nativeId)?.title
    const harness = descriptors.find((entry) => entry.provider === failure.harness)?.displayName ?? failure.harness
    return title ? `“${title}”` : `A ${harness} session`
  }
}

/** How often the rail reads the status: the host keeps it, so a read costs nothing but the call. */
const RAIL_READ_EVERY_MS = 10_000

/**
 * Above the rail's footer while Sessions aren't synced, as the sync daemon says (a failure that lasted, kept until the
 * Session goes): how many, and what kept the first out, opening Settings › Account, where each is said. Nothing at all
 * while sync is well, and nothing for a failure the next try heals: the rule is the daemon's, not read off a clock here.
 */
export function SyncRailLine() {
  const status = useSyncStatus((state) => state.status)
  useEffect(() => syncStatus.watch(RAIL_READ_EVERY_MS), [])
  if (!status || !("tiers" in status)) return null
  const [first] = status.failures
  if (!first) return null
  const notSynced = status.notSynced ?? status.failures.length
  const reason = `${syncFailureWords(first.kind).what} · since ${sinceAt(first.since ?? first.at)}`
  return (
    <button
      type="button"
      data-sync-rail={notSynced}
      onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" }))}
      className="pressable flex w-full items-center gap-2.5 border-t border-hairline px-3 py-2.5 text-left hover:bg-fill-hover"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium text-negative">{count(notSynced, "Session")} not synced</span>
        <span className="truncate text-label text-faint" title={reason}>{reason}</span>
      </span>
      <span className="shrink-0 text-label text-muted-foreground">Why</span>
    </button>
  )
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`
}

/** When something began, as a clock reads it: "5:20 AM" today, else its day. */
function sinceAt(at: number): string {
  return new Date(at).toDateString() === new Date().toDateString() ? formatTime(at) : formatDay(at)
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
