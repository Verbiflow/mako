// Prototype boards for three visual directions; never imported by the application entry point.
import type { CSSProperties, ReactNode } from "react"
import { ArrowUpIcon, InboxIcon, GitPullRequestIcon, PlusIcon, SearchIcon, SquarePenIcon, TimerIcon } from "lucide-react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"

type Dir = "a" | "b" | "c"
type State = "thinking" | "writing" | "tool" | "needs" | "lead" | "queued" | "done" | "failed" | "idle"
type Kind = "apex" | "fin"

const FIN = "M4.97 5.01C14.94 6.3 20.86 13.77 27.77 26.99L4.97 26.99C8.16 22.52 10.88 13.84 4.97 5.01Z"

/** The fin: its body, and for an Apex the lit lower face the app icon has. */
function FinGlyph() {
  return (
    <svg viewBox="2 2 28 28" aria-hidden>
      <defs>
        <clipPath id="vd-face">
          <polygon points="0,14.5 7.4,14.5 27.8,27.5 0,27.5" />
        </clipPath>
      </defs>
      <path d={FIN} fill="currentColor" />
      <path d={FIN} className="vd-fin-face" clipPath="url(#vd-face)" />
    </svg>
  )
}

/** An Apex's or a Fin's mark in one direction and state; the harness a small square badge in its corner. */
export function AgentIcon({ dir, state, kind, harness, size = 20, cut }: { dir: Dir; state: State; kind: Kind; harness?: string; size?: number; cut?: string }) {
  const style = { "--s": `${size}px`, ...(cut && { "--vd-cut": cut }) } as CSSProperties
  return (
    <span className="vd-icon" data-dir={dir} data-state={state} data-kind={kind} style={style}>
      <span className="vd-water">{dir === "c" ? <i /> : null}</span>
      <span className="vd-wake" />
      <span className="vd-band" />
      <span className="vd-body">
        <FinGlyph />
      </span>
      <span className="vd-bar" />
      {harness ? (
        <span className="vd-badge">
          <HarnessIcon harness={harness} />
        </span>
      ) : null}
    </span>
  )
}

const STATES: { state: State; word: string }[] = [
  { state: "thinking", word: "Thinking" },
  { state: "writing", word: "Writing" },
  { state: "tool", word: "Running a tool" },
  { state: "needs", word: "Needs you" },
  { state: "lead", word: "Asking its Apex" },
  { state: "queued", word: "Queued" },
  { state: "done", word: "Done" },
  { state: "failed", word: "Failed" },
  { state: "idle", word: "Idle" },
]

const NAMES: Record<Dir, string> = { a: "A · The living fin", b: "B · The tile", c: "C · The waterline" }

export function StatesBoard({ dir }: { dir: Dir }) {
  return (
    <div className="vd flex flex-col gap-4 p-6">
      <h1 className="text-title font-semibold">{NAMES[dir]}</h1>
      <div className="grid grid-cols-[repeat(9,minmax(0,1fr))] gap-3">
        {STATES.map(({ state, word }) => (
          <div key={state} className="flex flex-col items-center gap-3 bg-surface px-2 py-4">
            <AgentIcon dir={dir} state={state} kind="apex" size={40} cut="var(--surface)" />
            <AgentIcon dir={dir} state={state} kind="fin" harness="codex" size={40} cut="var(--surface)" />
            <span className="flex items-center gap-2">
              <AgentIcon dir={dir} state={state} kind="apex" size={20} cut="var(--surface)" />
              <AgentIcon dir={dir} state={state} kind="fin" harness="claude" size={20} cut="var(--surface)" />
            </span>
            <span className="text-center text-label text-muted-foreground">{word}</span>
          </div>
        ))}
      </div>
      <p className="text-label text-faint">Top: an Apex (the two-tone fin of the app icon). Below: a Fin, its harness as a square badge. Then both at the rail's 20 px.</p>
    </div>
  )
}

/** One row of the rail: mark, title, one trailing slot. */
function RailRow({ dir, state, kind, harness, title, end, lit }: { dir: Dir; state: State; kind: Kind; harness: string; title: string; end: string; lit?: boolean }) {
  return (
    <div className={cn("flex h-7 items-center gap-2 pr-2 pl-2", lit && "bg-raised")}>
      <AgentIcon dir={dir} state={state} kind={kind} harness={kind === "fin" ? harness : undefined} cut={lit ? "var(--raised)" : "var(--shell)"} />
      <span className={cn("min-w-0 flex-1 truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>{title}</span>
      <span className={cn("shrink-0 text-label", end === "Needs you" ? "font-medium text-caution" : end === "Failed" ? "text-negative" : "tabular text-faint")}>{end}</span>
    </div>
  )
}

function Rail({ dir }: { dir: Dir }) {
  const top: [ReactNode, string, string?][] = [
    [<SquarePenIcon key="n" />, "New thread"],
    [<SearchIcon key="s" />, "Search"],
    [<InboxIcon key="i" />, "Inbox", "2"],
    [<GitPullRequestIcon key="p" />, "Pull requests", "3"],
    [<TimerIcon key="t" />, "Automations"],
  ]
  return (
    <aside className="flex w-[268px] shrink-0 flex-col gap-3 bg-shell px-2 pt-12">
      <nav className="flex flex-col">
        {top.map(([icon, label, count]) => (
          <div key={label} className="flex h-7 items-center gap-2.5 px-2 text-ui text-foreground/85">
            <span className="flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>
            <span className="flex-1">{label}</span>
            {count ? <span className={cn("tabular px-1 text-label", label === "Inbox" ? "bg-caution/15 font-medium text-caution" : "text-faint")}>{count}</span> : null}
          </div>
        ))}
      </nav>
      <div className="flex flex-col">
        <p className="flex h-7 items-center px-2 text-label text-faint">Threads</p>
        <p className="flex h-7 items-center px-2 text-label font-medium text-muted-foreground">mako</p>
        <RailRow dir={dir} state="writing" kind="apex" harness="claude" title="Mobile polish" end="now" lit />
        <div className="pl-5">
          <RailRow dir={dir} state="needs" kind="fin" harness="cursor" title="Sheet motion on iPad" end="Needs you" />
        </div>
        <RailRow dir={dir} state="tool" kind="apex" harness="codex" title="Refactor the composer focus" end="4m" />
        <RailRow dir={dir} state="done" kind="apex" harness="grok" title="Tighten the webhook types" end="3h" />
        <p className="mt-2 flex h-7 items-center px-2 text-label font-medium text-muted-foreground">api</p>
        <RailRow dir={dir} state="failed" kind="apex" harness="claude" title="Trace the flaky webhook test" end="Failed" />
        <RailRow dir={dir} state="idle" kind="apex" harness="opencode" title="Ship the billing webhooks" end="1d" />
      </div>
    </aside>
  )
}

const CREW: { state: State; harness: string; title: string; line: string; time: string; model: string }[] = [
  { state: "needs", harness: "cursor", title: "Sheet motion on iPad", line: "Approve: npm ci", time: "22m", model: "Cursor · composer-2.5" },
  { state: "writing", harness: "codex", title: "Quiet-hours push wording", line: "Writing the report", time: "14m", model: "Codex · gpt-5.6" },
  { state: "tool", harness: "claude", title: "Composer chips on iPad", line: "Running npm run test:phone", time: "18m", model: "Claude · opus-5.5" },
  { state: "thinking", harness: "grok", title: "Dictation fallback", line: "Thinking", time: "11m", model: "Grok · build-1" },
  { state: "idle", harness: "opencode", title: "Push token refresh", line: "Idle: a message gives it its next turn", time: "9m", model: "OpenCode · zen" },
]

function CrewCard({ dir, compact }: { dir: Dir; compact?: boolean }) {
  const needs = CREW.filter((fin) => fin.state === "needs")
  const working = CREW.filter((fin) => fin.state === "writing" || fin.state === "tool" || fin.state === "thinking")
  const idle = CREW.filter((fin) => fin.state === "idle")
  const panel = dir === "b"
  const row = (fin: (typeof CREW)[number]) => (
    <div key={fin.title} className="vd-crew-row flex h-8 items-center gap-2.5 px-3">
      <AgentIcon dir={dir} state={fin.state} kind="fin" harness={fin.harness} cut={panel ? "var(--raised)" : "var(--surface)"} />
      <span className="min-w-0 shrink-0 truncate text-ui text-foreground">{fin.title}</span>
      <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">{fin.line}</span>
      <span className="tabular shrink-0 text-label text-faint">{fin.time}</span>
    </div>
  )
  return (
    <section className={cn("vd-crew flex flex-col", panel ? "bg-raised" : "bg-transparent")}>
      <header className={cn("flex h-10 items-center gap-2.5 px-3", panel && "bg-shell")}>
        <AgentIcon dir={dir} state="writing" kind="apex" cut={panel ? "var(--shell)" : "var(--surface)"} />
        <span className="text-ui font-semibold text-foreground">5 Fins</span>
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">1 needs you · 3 working · 1 idle</span>
        {!compact ? <span className="text-label text-faint">Stop all</span> : null}
      </header>
      <div className="flex flex-col gap-3 pb-3">
        <div className="flex flex-col">
          <p className="flex h-6 items-center px-3 text-label text-caution">Needs you</p>
          {needs.map((fin) => (
            <div key={fin.title} className="vd-crew-needs mx-3 flex flex-col gap-2 px-3 py-2.5">
              <div className="flex items-center gap-2.5">
                <AgentIcon dir={dir} state="needs" kind="fin" harness={fin.harness} cut="var(--raised)" />
                <span className="text-ui font-medium text-foreground">{fin.title}</span>
                <span className="min-w-0 flex-1 truncate text-label text-faint">{fin.model}</span>
                <span className="tabular text-label text-faint">{fin.time}</span>
              </div>
              <p className="text-ui text-foreground">{fin.line}</p>
              <div className={cn("flex gap-1.5", compact && "flex-col")}>
                <button type="button" data-primary className={cn("vd-button px-3 text-ui font-medium", compact ? "h-11" : "h-7")}>Allow once</button>
                <button type="button" className={cn("vd-button px-3 text-ui", compact ? "h-11" : "h-7")}>Refuse</button>
              </div>
              <p className="text-label text-faint">Only you can answer this command.</p>
            </div>
          ))}
        </div>
        <div className="flex flex-col">
          <p className="flex h-6 items-center px-3 text-label text-faint">Working</p>
          {working.map(row)}
        </div>
        <div className="flex flex-col">
          <p className="flex h-6 items-center px-3 text-label text-faint">Idle</p>
          {idle.map(row)}
        </div>
      </div>
    </section>
  )
}

function Avatar({ dir, who }: { dir: Dir; who: "person" | "apex" }) {
  if (who === "person") return <span className="vd-avatar vd-person">A</span>
  return (
    <span className="vd-avatar bg-raised">
      <AgentIcon dir={dir} state="writing" kind="apex" harness="claude" size={20} cut="var(--raised)" />
    </span>
  )
}

function Transcript({ dir, compact }: { dir: Dir; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-6", compact ? "px-4" : "mx-auto w-full max-w-[720px] px-6")}>
      <div className="flex items-start justify-end gap-2.5">
        <p className="max-w-[80%] bg-raised px-3.5 py-2.5 text-prose leading-relaxed text-foreground">How are the queued ones doing? Keep the keyboard's own mic as the fallback.</p>
        <Avatar dir={dir} who="person" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-label text-faint">
          <Avatar dir={dir} who="apex" />
          <span className="text-muted-foreground">Mobile polish</span>
          <span>· Claude Code · Opus 5.5</span>
        </div>
        <p className="text-prose leading-relaxed text-foreground">Sheet motion is measuring the container in split view now; it takes this at its next step. The other three are moving.</p>
      </div>
      <CrewCard dir={dir} compact={compact} />
    </div>
  )
}

function Composer({ dir, compact }: { dir: Dir; compact?: boolean }) {
  return (
    <div className={cn("vd-composer flex flex-col", compact ? "mx-3 mb-3" : "mx-auto mb-4 w-full max-w-[720px]")}>
      <p className="px-3.5 pt-3 pb-6 text-prose text-faint">Steer Claude Code</p>
      <div className="flex h-10 items-center gap-3 px-2.5 text-ui text-faint">
        <PlusIcon className="size-4" />
        <span className="flex items-center gap-1.5 whitespace-nowrap font-medium text-foreground">
          <HarnessIcon harness="claude" className="size-3.5" /> Opus 5.5 {compact ? null : <span className="font-normal text-muted-foreground">High</span>}
        </span>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <AgentIcon dir={dir} state="writing" kind="apex" size={16} cut="var(--raised)" /> {compact ? "5 Fins" : "5 Fins · 1 needs you"}
        </span>
        <span className="flex-1" />
        <span className="flex size-7 items-center justify-center bg-foreground text-shell">
          <ArrowUpIcon className="size-4" />
        </span>
      </div>
    </div>
  )
}

export function DeskBoard({ dir }: { dir: Dir }) {
  return (
    <div className="vd flex h-dvh bg-shell">
      <Rail dir={dir} />
      <main className="mt-1.5 mr-1.5 mb-1.5 flex min-w-0 flex-1 flex-col bg-surface">
        <div className="flex h-10 items-center gap-2 bg-shell px-2">
          <span className="flex h-7 items-center gap-2 bg-raised px-2 text-ui font-medium">
            <AgentIcon dir={dir} state="writing" kind="apex" cut="var(--raised)" /> Mobile polish
          </span>
          <span className="flex h-7 items-center gap-2 px-2 text-ui text-faint">
            <AgentIcon dir={dir} state="needs" kind="fin" harness="cursor" /> Sheet motion on iPad
          </span>
        </div>
        <div className="flex-1 overflow-hidden pt-8">
          <Transcript dir={dir} />
        </div>
        <Composer dir={dir} />
      </main>
    </div>
  )
}

export function PhoneBoard({ dir }: { dir: Dir }) {
  return (
    <div className="vd flex h-dvh flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2.5 px-4">
        <AgentIcon dir={dir} state="writing" kind="apex" size={24} cut="var(--surface)" />
        <span className="text-title font-semibold">Mobile polish</span>
      </header>
      <div className="flex-1 overflow-hidden pt-2">
        <Transcript dir={dir} compact />
      </div>
      <Composer dir={dir} compact />
    </div>
  )
}
