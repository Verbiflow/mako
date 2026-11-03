import type { ReactNode } from "react"
import { GitPullRequestIcon, InboxIcon, PanelLeftIcon, PlusIcon, SearchIcon, SquarePenIcon, TimerIcon } from "lucide-react"
import type { Rollup } from "@mako/host/contracts/children"
import { cn } from "@/lib/utils"
import { APEX_ID, AUTOMATIONS, PROJECTS, PULL_REQUESTS, THREADS, type Fin, type RailThread } from "./data"
import { Kbd, LiveMark, Pips } from "./marks"

export type Place = { kind: "thread"; id: string } | { kind: "fin"; id: string } | { kind: "inbox" }

function NavRow({ icon, label, end, active, onClick }: { icon: ReactNode; label: string; end?: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active || undefined}
      className="pressable group flex h-7 w-full items-center gap-2.5 rounded-md pl-2 pr-1.5 text-left text-ui text-foreground/85 hover:bg-fill-hover data-active:bg-raised data-active:text-foreground"
    >
      <span className="flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end}
    </button>
  )
}

function Count({ children, tone }: { children: ReactNode; tone?: "caution" }) {
  return tone === "caution" ? (
    <span className="tabular flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--caution)_16%,transparent)] px-1.5 text-label font-medium text-caution">{children}</span>
  ) : (
    <span className="tabular px-1 text-label text-faint">{children}</span>
  )
}

function Row({ thread, active, onOpen }: { thread: RailThread; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-active={active || undefined}
      className="pressable group flex h-7 w-full items-center gap-2 rounded-md pl-1.5 pr-2 text-left hover:bg-fill-hover data-active:bg-raised"
    >
      <LiveMark harness={thread.harness} state={thread.mark} lit={active} cut={active ? "var(--raised)" : undefined} />
      <span className={cn("min-w-0 flex-1 truncate text-ui", active ? "font-medium text-foreground" : "text-foreground/85")}>{thread.title}</span>
      <RowEnd thread={thread} />
    </button>
  )
}

function RowEnd({ thread }: { thread: RailThread }) {
  if (thread.mark === "needs") return <span className="shrink-0 text-label font-medium text-caution">Needs you</span>
  if (thread.mark === "failed") return <span className="shrink-0 text-label text-negative">Failed</span>
  return <span className="tabular shrink-0 text-label text-faint">{thread.age}</span>
}

function ApexRow({ thread, fins, counts, active, opened, onOpen, onOpenFin }: { thread: RailThread; fins: Fin[]; counts: Rollup; active: boolean; opened?: string; onOpen: () => void; onOpenFin: (id: string) => void }) {
  const asking = fins.filter((fin) => fin.group === "needs")
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onOpen}
        data-active={active || undefined}
        className="pressable group flex w-full flex-col gap-1 rounded-md py-1.5 pl-1.5 pr-2 text-left hover:bg-fill-hover data-active:bg-raised"
      >
        <span className="flex w-full items-center gap-2">
          <LiveMark harness={thread.harness} state={thread.mark} lit={active} cut={active ? "var(--raised)" : undefined} />
          <span className={cn("min-w-0 flex-1 truncate text-ui", active ? "font-medium text-foreground" : "text-foreground/85")}>{thread.title}</span>
          <span className="tabular shrink-0 text-label text-faint">{thread.age}</span>
        </span>
        <span className="flex w-full items-center gap-2 pl-7">
          <Pips fins={fins} />
          <span className="tabular min-w-0 flex-1 truncate text-label text-faint">{counts.total} Fins</span>
        </span>
      </button>
      {asking.map((fin) => (
        <button
          key={fin.agent.nativeId}
          type="button"
          onClick={() => onOpenFin(fin.agent.nativeId)}
          data-active={opened === fin.agent.nativeId || undefined}
          className="pressable relative flex h-7 w-full items-center gap-2 rounded-md pl-7 pr-2 text-left hover:bg-fill-hover data-active:bg-raised"
        >
          <span aria-hidden className="absolute bottom-1/2 left-[15px] top-0 w-2.5 rounded-bl-md border-b border-l border-hairline" />
          <LiveMark harness={fin.agent.provider} state={fin.mark} />
          <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">{fin.agent.title}</span>
          <span className="shrink-0 text-label font-medium text-caution">Needs you</span>
        </button>
      ))}
    </div>
  )
}

export function Sidebar({ place, fins, counts, asks, onPlace, phone }: { place: Place; fins: Fin[]; counts: Rollup; asks: number; onPlace: (place: Place) => void; phone?: boolean }) {
  const open = (id: string) => onPlace({ kind: "thread", id })
  const pinned = THREADS.filter((thread) => thread.pinned)
  const rowFor = (thread: RailThread) =>
    thread.id === APEX_ID ? (
      <ApexRow key={thread.id} thread={thread} fins={fins} counts={counts} active={place.kind === "thread" && place.id === thread.id} opened={place.kind === "fin" ? place.id : undefined} onOpen={() => open(thread.id)} onOpenFin={(id) => onPlace({ kind: "fin", id })} />
    ) : (
      <Row key={thread.id} thread={thread} active={place.kind === "thread" && place.id === thread.id} onOpen={() => open(thread.id)} />
    )
  return (
    <aside className={cn("flex h-full shrink-0 flex-col bg-shell", phone ? "w-full" : "w-[276px] border-r border-hairline")}>
      {!phone ? (
        <div className="flex h-[38px] shrink-0 items-center gap-2 pl-[14px] pr-2">
          <span className="flex gap-2" aria-hidden>
            {["#ff5f57", "#febc2e", "#28c840"].map((color) => <span key={color} className="size-3 rounded-full opacity-90" style={{ background: color }} />)}
          </span>
          <span className="flex-1" />
          <button type="button" aria-label="Hide the sidebar" className="pressable flex size-7 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground">
            <PanelLeftIcon className="size-4" />
          </button>
        </div>
      ) : null}
      <nav className="flex shrink-0 flex-col gap-px px-2 pb-2 pt-1">
        <NavRow icon={<SquarePenIcon />} label="New thread" end={<span className="hidden gap-0.5 group-hover:flex"><Kbd>⌘</Kbd><Kbd>N</Kbd></span>} />
        <NavRow icon={<SearchIcon />} label="Search" end={<span className="hidden gap-0.5 group-hover:flex"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>} />
        <NavRow icon={<InboxIcon />} label="Inbox" active={place.kind === "inbox"} onClick={() => onPlace({ kind: "inbox" })} end={asks ? <Count tone="caution">{asks}</Count> : null} />
        <NavRow icon={<GitPullRequestIcon />} label="Pull requests" end={<Count>{PULL_REQUESTS}</Count>} />
        <NavRow icon={<TimerIcon />} label="Automations" end={<Count>{AUTOMATIONS} on</Count>} />
      </nav>
      <div className="mx-3 border-t border-hairline" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {pinned.length ? (
          <section className="mb-2">
            <h3 className="flex h-7 items-center px-2 text-label text-faint">Pinned</h3>
            {pinned.map(rowFor)}
          </section>
        ) : null}
        {PROJECTS.map((project) => (
          <section key={project.name} className="mb-2">
            <h3 className="group flex h-7 items-center gap-1.5 px-2 text-label">
              <span className="font-medium text-muted-foreground">{project.name}</span>
              <span className="flex-1" />
              <PlusIcon className="size-3.5 text-faint opacity-0 group-hover:opacity-100" />
            </h3>
            {THREADS.filter((thread) => thread.project === project.name && !thread.pinned).map(rowFor)}
          </section>
        ))}
      </div>
      {!phone ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-t border-hairline px-3">
          <span className="flex size-6 items-center justify-center rounded-full bg-raised text-label font-medium text-foreground">A</span>
          <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">Ada</span>
          <span className="flex items-center gap-1.5 text-label text-faint">
            <span className="size-1.5 rounded-full bg-positive" />
            This Mac · Cloud
          </span>
        </div>
      ) : null}
    </aside>
  )
}
