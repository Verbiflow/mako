import { useEffect, useState } from "react"
import { CheckIcon, CopyIcon, EllipsisIcon, RotateCwIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { syncFailureWords, type SyncFailureView, type SyncStatus, type SyncTier, type SyncTierName } from "@mako/host/contracts/sync-status"
import { Action, Chip, Eyebrow, IconAction, ListCard, ListCardRow, Meter } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { syncStatus, useSyncStatus } from "@/state/sync-status"
import { formatDay, formatRelative, formatTime } from "@/lib/format"
import { useThreads } from "@/state/thread-store"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { localWords } from "@mako/protocol/computer-words"

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
              {localWords("Every Thread you worked in during the last 7 days goes up whole, the newest first: the one you're working in within seconds of each turn, then today's, then the rest of the week. Your other devices can read each one, and continue it, even while this Mac is off.")}
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
              {status?.state === "starting" ? localWords(`Reading ${count(status.sessions, "Session")} on this Mac…`) : localWords("Reading what's on this Mac…")}
            </p>
          </ListCardRow>
        )}
      </ListCard>
      {status && "tiers" in status && status.unreachableSince !== undefined ? <Unreachable since={status.unreachableSince} /> : null}
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
  if (unread > 0) parts.push(localWords(`${unread} still being read on this Mac`))
  return parts.join(" · ")
}

function footer(status: Running): string {
  const parts: string[] = []
  if (status.state === "paused") parts.push(localWords("Catching up waits while this Mac is on a low battery or in Low Power Mode; the Thread you're working in still goes up."))
  parts.push(status.lastSuccessAt ? `Last sent ${ago(status.lastSuccessAt)}.` : "Nothing sent yet.")
  if (status.stale > 0) parts.push(`${count(status.stale, "Session")} changed since ${status.stale === 1 ? "its" : "their"} last copy, going up in turn.`)
  if (status.retrying && status.unreachableSince === undefined) parts.push(`${count(status.retrying, "Session")} will be sent again shortly.`)
  const backfill = status.backfill
  if (backfill && backfill.endedAt === undefined && backfill.done < backfill.sessions)
    parts.push(localWords(`Reading this Mac's older sessions into its records: ${backfill.done.toLocaleString()} of ${backfill.sessions.toLocaleString()}.`))
  return parts.join(" ")
}

/**
 * The Sessions not synced, as the sync daemon says (a failure that lasted, never one the next try healed): a quiet line
 * each, in a person's words with what Mako does next, the one action that can fix it where there is one (reading a
 * Session this Mac couldn't read, again), and the account's own words with the correlation ID copied from its menu.
 */
function Failures({ status }: { status: Running }) {
  const name = useSessionName()
  const [first] = status.failures
  if (!first) return null
  const notSynced = status.notSynced ?? status.failures.length
  return (
    <div role="status" className="flex flex-col px-3" data-sync-failures>
      {notSynced === 1 ? null : <p className="py-1 text-label font-medium text-negative">{count(notSynced, "Session")} aren't synced</p>}
      {status.failures.map((failure) => (
        <FailureLine key={`${failure.harness}:${failure.nativeId}`} failure={failure} named={name(failure).text} alone={notSynced === 1} />
      ))}
      {notSynced > status.failures.length ? <p className="py-1 text-label text-faint">And {count(notSynced - status.failures.length, "more Session")}.</p> : null}
    </div>
  )
}

function FailureLine({ failure, named, alone }: { failure: SyncFailureView; named: string; alone: boolean }) {
  const [reading, setReading] = useState(false)
  const words = syncFailureWords(failure.kind)
  const readAgain = () => {
    setReading(true)
    void syncStatus.readAgain(failure.harness, failure.nativeId)
      .then((read) => (read ? toast("Read, and going up") : toast.error(localWords("Mako still couldn't read it on this Mac"))), () => toast.error(localWords("Mako still couldn't read it on this Mac")))
      .finally(() => setReading(false))
  }
  return (
    <div className="flex items-center gap-3 py-1.5" data-sync-failure={failure.nativeId}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-label text-foreground" title={`${named} isn't synced`}>
          {named}
          {alone ? <span className="text-negative"> isn't synced</span> : null}
        </p>
        <p className="text-label text-faint">
          {words.what} · since {sinceAt(failure.since ?? failure.at)}. {words.next}
        </p>
      </div>
      {failure.kind === "unread" ? (
        <Action size="xs" className="shrink-0" disabled={reading} onClick={readAgain} data-sync-read-again>
          {reading ? <Spinner className="size-3" /> : <RotateCwIcon />}
          {reading ? "Reading…" : "Read again"}
        </Action>
      ) : null}
      <Menu modal={false}>
        <MenuTrigger asChild>
          <IconAction size="xs" label="More" className="shrink-0" data-sync-failure-menu>
            <EllipsisIcon />
          </IconAction>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-40">
          <MenuItem onSelect={() => copy(detailLine(failure))}>
            <CopyIcon />
            Copy details
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * The account not answering this Mac, said once for the account rather than as each Session's failure: only while the
 * latest request to it got no answer and that has lasted, gone at its next answer.
 */
function Unreachable({ since }: { since: number }) {
  return (
    <div role="status" className="flex flex-col px-3 py-1.5" data-sync-unreachable>
      <p className="text-label font-medium text-negative">{syncFailureWords("unreachable").what}</p>
      <p className="text-label text-faint">Since {sinceAt(since)}. Mako sends what's waiting on its own as soon as the account answers.</p>
    </div>
  )
}

/** One failure for a report: when it began and was last tried, the Session, the correlation ID, the account's words. */
function detailLine(failure: SyncFailureView): string {
  return [new Date(failure.since ?? failure.at).toISOString(), new Date(failure.at).toISOString(), failure.kind ?? "-", failure.harness, failure.nativeId, failure.correlationId ?? "-", failure.message].join("\t")
}

/**
 * A Session as the person knows it: by its title, as the host lists it or else the rail, with the harness it runs in;
 * one with neither is its harness's session.
 */
function useSessionName(): (failure: SyncFailureView) => { title?: string; harness: string; text: string } {
  const descriptors = useThreads((state) => state.descriptors)
  const threads = useThreads((state) => state.threads)
  return (failure) => {
    const title = failure.title ?? threads.find((thread) => thread.harness === failure.harness && thread.nativeId === failure.nativeId)?.title
    const harness = descriptors.find((entry) => entry.provider === failure.harness)?.displayName ?? failure.harness
    return title ? { title: `“${title}”`, harness, text: `“${title}” in ${harness}` } : { harness, text: `A ${harness} session` }
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
  const name = useSessionName()
  useEffect(() => syncStatus.watch(RAIL_READ_EVERY_MS), [])
  if (!status || !("tiers" in status)) return null
  const [first] = status.failures
  if (!first && status.unreachableSince !== undefined) return <UnreachableRailLine since={status.unreachableSince} waiting={status.retrying ?? 0} />
  if (!first) return null
  const notSynced = status.notSynced ?? status.failures.length
  // One Session out is named by its title, the title the part that gives way to the rail's width; the harness leads its reason.
  const one = notSynced === 1 ? name(first) : undefined
  const reason = [one?.title ? one.harness : undefined, syncFailureWords(first.kind).what, `since ${sinceAt(first.since ?? first.at)}`].filter(Boolean).join(" · ")
  return (
    <button
      type="button"
      data-sync-rail={notSynced}
      onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" }))}
      className="pressable flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-fill-hover"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        {one?.title ? (
          <span className="flex min-w-0 gap-1 text-label font-medium text-negative" title={`${one.text} isn't synced`}>
            <span className="min-w-0 truncate">{one.title}</span>
            <span className="shrink-0">isn't synced</span>
          </span>
        ) : (
          <span className="truncate text-label font-medium text-negative">{count(notSynced, "Session")} not synced</span>
        )}
        <span className="truncate text-label text-faint" title={reason}>{reason}</span>
      </span>
      <span className="shrink-0 text-label text-muted-foreground">Why</span>
    </button>
  )
}

/** The rail's line while the account isn't answering: what waits on it, and since when this time. */
function UnreachableRailLine({ since, waiting }: { since: number; waiting: number }) {
  const reason = `${syncFailureWords("unreachable").what} · since ${sinceAt(since)}`
  return (
    <button
      type="button"
      data-sync-rail-unreachable
      onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" }))}
      className="pressable flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-fill-hover"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium text-negative">{waiting ? `${count(waiting, "Session")} not synced` : "Not syncing"}</span>
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
