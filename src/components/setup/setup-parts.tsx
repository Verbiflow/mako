import { useState, type ReactNode } from "react"
import { type LucideIcon, ChevronRightIcon, CloudIcon, CommandIcon, FileTextIcon, FolderIcon, GitBranchIcon, KeyRoundIcon, LaptopIcon, PlugIcon, PlusIcon, ServerIcon, WrenchIcon } from "lucide-react"
import {
  askAnswerLabel,
  askAnswers,
  askLine,
  partSummary,
  ROW_ACTION_LABELS,
  rowAction,
  SCOPE_WORDS,
  SETUP_AWAY_ALLOW,
  SETUP_AWAY_EMPTY,
  SETUP_AWAY_NOTE,
  SETUP_PART_ADDS,
  SETUP_PART_TITLES,
  syncWords,
  type RowIcon,
  type SetupAsk,
  type SetupListPart,
  type SetupPartView,
  type SetupPlace,
  type SetupPlaceView,
  type SetupRow,
  type SyncSaid,
  type SyncTone,
} from "@mako/host/contracts/setup"
import { Action, Eyebrow } from "@/components/ui/kit"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { ASK_TOUCH, wantLine } from "@/lib/ask-card"
import { AskHeading } from "@/components/ui/ask-heading"
import { addTo, answerAsk, readSetup, rowTap, useAway, useSetup } from "@/state/setup"

/** The dot's colour by its tone; the words beside it always say the same. */
const DOT = {
  positive: "bg-positive",
  caution: "bg-caution",
  negative: "bg-negative",
  attention: "bg-attention",
  neutral: "bg-faint",
} as const satisfies Record<SyncTone, string>

export function SyncDot({ tone }: { tone: SyncTone }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
}

const ICONS = {
  repository: GitBranchIcon,
  file: FileTextIcon,
  folder: FolderIcon,
  key: KeyRoundIcon,
  tool: WrenchIcon,
  service: PlugIcon,
  command: CommandIcon,
} as const satisfies Record<RowIcon, LucideIcon>

export function PlaceIcon({ place, className }: { place: SetupPlace; className?: string }) {
  const Icon = place.kind === "cloud" ? CloudIcon : place.platform === "mac" ? LaptopIcon : ServerIcon
  return <Icon aria-hidden className={className} />
}

/** One thing the place has: its name and scope, where it comes from, its state in words, and its one button. */
function Row({ folder, place, row, now, compact }: { folder: string; place: string; row: SetupRow; now: number; compact: boolean }) {
  const said = syncWords(row.sync, now)
  const action = rowAction(row, now, useAway(folder))
  const busy = useSetup((state) => Boolean(state.busy[row.id]))
  const Icon = ICONS[row.icon]
  return (
    <div data-setup-row={row.id} data-sync={row.sync.state} className="flex items-start gap-3 px-3 py-2.5">
      <Icon aria-hidden className="mt-[3px] size-3.5 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("truncate text-ui font-medium text-foreground", row.mono && "font-mono text-label")}>{row.name}</span>
          {row.scope ? <span className="shrink-0 text-label text-faint">{SCOPE_WORDS[row.scope]}</span> : null}
        </div>
        <p className="mt-0.5 text-label leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{row.detail}</p>
        {compact ? <SyncLine said={said} className="mt-1" /> : null}
      </div>
      <div className="flex h-5 shrink-0 items-center gap-2">
        {compact ? null : <SyncLine said={said} />}
        {action ? (
          <Action tone="quiet" size="xs" data-setup-action={action} disabled={busy} onClick={() => rowTap(folder, place, row, action)}>
            {busy ? "…" : ROW_ACTION_LABELS[action]}
          </Action>
        ) : null}
      </div>
    </div>
  )
}

function SyncLine({ said, className }: { said: SyncSaid; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-label tabular-nums whitespace-nowrap", said.tone === "attention" ? "text-attention" : "text-muted-foreground", className)}>
      <SyncDot tone={said.tone} />
      {said.words}
    </span>
  )
}

function Answer({ primary, disabled, onClick, children }: { primary?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pressable flex h-7 items-center px-2.5 text-label font-medium disabled:opacity-50",
        ASK_TOUCH,
        primary ? "bg-foreground text-background hover:bg-foreground/90" : "bg-raised text-foreground/85 hover:bg-fill-selected"
      )}
    >
      {children}
    </button>
  )
}

function minutes(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000))
  if (total < 60) return `${total}m`
  const hours = Math.floor(total / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/**
 * An agent's ask, drawn as the crew card draws a Fin that needs you: the attention band, the asker's fin with its
 * harness, what it wants and why in its words, and one-tap answers, the narrowest first.
 */
export function AskRow({ folder, ask, now, compact }: { folder: string; ask: SetupAsk; now: number; compact: boolean }) {
  useHarnessIdentity()
  const busy = useSetup((state) => Boolean(state.busy[`ask:${ask.id}`]))
  const away = useAway(folder)
  const line = askLine(ask)
  return (
    <div
      data-setup-ask={ask.id}
      aria-busy={busy || undefined}
      className="bg-[color-mix(in_oklab,var(--attention)_8%,var(--raised))] px-3 py-2.5 shadow-[inset_2px_0_0_var(--attention)]"
    >
      <AskHeading
        mark={
          <LiveMark state="needs" kind={ask.by.fin ? "fin" : "thread"} cut="var(--raised)">
            {ask.by.harness ? <HarnessIcon harness={ask.by.harness} /> : null}
          </LiveMark>
        }
        want={
          <>
            {wantLine({ want: line.verb })} <span className="font-mono text-label">{line.thing}</span>
            {line.after && !compact ? `, ${line.after}` : null}
          </>
        }
        who={ask.by.title}
        age={minutes(now - ask.at)}
      />
      <p className="mt-1 pl-7 text-label leading-relaxed text-muted-foreground">“{ask.why}”</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
        {away && askAnswers(ask).length > 1 ? <span data-setup-away-allow className="mr-1 text-label text-muted-foreground">{SETUP_AWAY_ALLOW}</span> : null}
        {askAnswers(ask, away).map((answer, index) => (
          <Answer key={answer} primary={index === 0 && !away} disabled={busy} onClick={() => void answerAsk(folder, ask, answer)}>
            {askAnswerLabel(ask, answer, compact)}
          </Answer>
        ))}
      </div>
    </div>
  )
}

function PartHead({ title, hint, add, attention }: { title: string; hint?: string; add?: { label: string; onClick: () => void }; attention?: boolean }) {
  return (
    <div className="flex h-6 items-center gap-3">
      <Eyebrow className={attention ? "text-attention" : undefined}>{title}</Eyebrow>
      {hint ? <span className="min-w-0 flex-1 truncate text-label text-faint">{hint}</span> : <span className="flex-1" />}
      {add ? (
        <Action size="xs" className="text-faint" onClick={add.onClick}>
          <PlusIcon />
          {add.label}
        </Action>
      ) : null}
    </div>
  )
}

/** Each part's hint, by the kind of place: what its rows are, in a few words. */
function partHint(part: SetupListPart, place: SetupPlace): string {
  const cloud = place.kind === "cloud"
  const here = place.kind === "device" && place.here
  switch (part) {
    case "code":
      return "Pushes only to its own repository"
    case "files":
      return cloud ? "From your Mac, outside Git" : here ? "Outside Git: what worktrees get, and what this Mac lends" : "Copied from your Mac when a Thread moves here"
    case "access":
      return "Names, scope and expiry; never a value"
    case "tools":
      return cloud ? "Mako's image, then this project's setup" : "What this project's Threads use here"
    case "services":
      return here ? "What the recipe starts, and what this Mac lends" : "What the recipe starts, and what's reached through your Mac"
  }
}

const EMPTY = {
  code: "No repository yet",
  files: "Nothing from outside Git",
  access: "No accounts or secrets",
  tools: "Nothing beyond the place's own",
  services: "Nothing started or reached",
} as const satisfies Record<SetupListPart, string>

function ListPart({ folder, view, part, now, compact }: { folder: string; view: SetupPlaceView; part: SetupPartView; now: number; compact: boolean }) {
  const away = useAway(folder)
  return (
    <section data-setup-part={part.part} className="flex flex-col gap-1.5">
      <PartHead title={SETUP_PART_TITLES[part.part]} hint={compact ? undefined : partHint(part.part, view.place)} add={compact || away ? undefined : { label: SETUP_PART_ADDS[part.part], onClick: () => addTo(folder, part.part, view) }} />
      <div className="flex flex-col divide-y divide-hairline bg-shell/55">
        {part.rows.length ? (
          part.rows.map((row) => <Row key={row.id} folder={folder} place={view.id} row={row} now={now} compact={compact} />)
        ) : (
          <p className="px-3 py-2.5 text-label text-faint">{away ? SETUP_AWAY_EMPTY : EMPTY[part.part]}</p>
        )}
      </div>
    </section>
  )
}

export function NeedsYou({ folder, asks, now, compact, hint }: { folder: string; asks: readonly SetupAsk[]; now: number; compact: boolean; hint?: string }) {
  if (!asks.length) return null
  return (
    <section data-setup-part="needs" className="flex flex-col gap-1.5">
      <PartHead title={SETUP_PART_TITLES.needs} hint={hint} attention />
      <div className="flex flex-col gap-px">
        {asks.map((ask) => <AskRow key={ask.id} folder={folder} ask={ask} now={now} compact={compact} />)}
      </div>
    </section>
  )
}

/** A place's page body: its asks, then its five parts, always in that order. */
export function SetupPlaceBody({ folder, view, now, compact = false }: { folder: string; view: SetupPlaceView; now: number; compact?: boolean }) {
  return (
    <>
      <NeedsYou folder={folder} asks={view.asks} now={now} compact={compact} hint={compact ? undefined : "Agents ask here and in your Inbox. Only your tap adds."} />
      {view.parts.map((part) => <ListPart key={part.part} folder={folder} view={view} part={part} now={now} compact={compact} />)}
    </>
  )
}

/** The phone's fold: each part as one line, opened to its rows. */
export function PartSummaryRow({ part, now, away, open, onToggle }: { part: SetupPartView; now: number; away: boolean; open: boolean; onToggle: () => void }) {
  const summary = partSummary(part, now, away)
  return (
    <button type="button" aria-expanded={open} data-setup-summary={part.part} onClick={onToggle} className="pressable flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left">
      <SyncDot tone={summary.tone} />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-foreground">{SETUP_PART_TITLES[part.part]}</span>
        <span className="block truncate text-label text-muted-foreground">{summary.line}</span>
      </span>
      <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-faint transition-transform duration-150 ease-[var(--ease-out)]", open && "rotate-90")} />
    </button>
  )
}

export function PartRows({ folder, view, part, now }: { folder: string; view: SetupPlaceView; part: SetupPartView; now: number }) {
  return (
    <div className="flex flex-col divide-y divide-hairline border-t border-hairline">
      {part.rows.map((row) => <Row key={row.id} folder={folder} place={view.id} row={row} now={now} compact />)}
    </div>
  )
}

/**
 * What a page built away from the Mac says of itself, on every surface that lists its grants (Settings › Setup, the
 * laptop browser's rail, the phone): it shows what the account lends, and the rest is the Mac's to show.
 */
export function SetupAwayNote({ className }: { className?: string }) {
  return (
    <p data-setup-away-note className={cn("text-label leading-relaxed text-muted-foreground", className)}>
      {SETUP_AWAY_NOTE}
    </p>
  )
}

/** A read that failed: why, in words, and Try again, which reads the folder's Setup once more. */
export function SetupReadFailed({ folder, why, className }: { folder: string; why: string; className?: string }) {
  const [trying, setTrying] = useState(false)
  return (
    <div data-setup-failed className={cn("flex flex-col items-start gap-2", className)}>
      <p className="text-ui text-negative">Setup couldn&apos;t be read. {why}</p>
      <Action tone="outline" size="sm" className={ASK_TOUCH} disabled={trying} onClick={() => {
        setTrying(true)
        void readSetup(folder).finally(() => setTrying(false))
      }}>
        {trying ? "Reading…" : "Try again"}
      </Action>
    </div>
  )
}
