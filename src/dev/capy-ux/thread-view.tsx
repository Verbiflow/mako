import { useLayoutEffect, useRef, type ReactNode } from "react"
import { ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, CircleDotIcon, CornerDownRightIcon, FileCodeIcon, GitBranchIcon, GitPullRequestIcon, LaptopIcon, PanelRightIcon, PlayIcon, PlusIcon, ShieldIcon, XIcon } from "lucide-react"
import type { Rollup } from "@mako/host/contracts/children"
import { rollupLine } from "@mako/host/contracts/children"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ApexMark } from "@/components/ui/apex-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import { APEX_ID, THREADS, type Ask, type Fin } from "./data"
import { CrewCard } from "./crew"
import { LiveMark } from "./marks"
import type { Place } from "./sidebar"

const APEX = THREADS.find((thread) => thread.id === APEX_ID)!

interface Tab {
  key: string
  title: string
  harness?: string
  state?: Fin["mark"]
  file?: boolean
  place: Place | null
}

export function TabStrip({ place, fins, onPlace }: { place: Place; fins: Fin[]; onPlace: (place: Place) => void }) {
  const sheet = fins.find((fin) => fin.name === "sheet-motion")
  const composer = THREADS.find((thread) => thread.id === "composer")!
  const tabs: Tab[] = [
    { key: APEX_ID, title: APEX.title, harness: APEX.harness, state: APEX.mark, place: { kind: "thread", id: APEX_ID } },
    ...(sheet ? [{ key: sheet.agent.nativeId, title: sheet.agent.title, harness: sheet.agent.provider, state: sheet.mark, place: { kind: "fin", id: sheet.agent.nativeId } as Place }] : []),
    { key: composer.id, title: composer.title, harness: composer.harness, state: composer.mark, place: { kind: "thread", id: composer.id } },
    { key: "file", title: "sheet.tsx", file: true, place: null },
  ]
  const selected = (tab: Tab) => tab.place && JSON.stringify(tab.place) === JSON.stringify(place)
  return (
    <div className="flex h-[38px] shrink-0 items-stretch border-b border-hairline bg-shell">
      <div className="flex min-w-0 flex-1 items-stretch">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => tab.place && onPlace(tab.place)}
            data-active={selected(tab) || undefined}
            className="pressable group relative flex min-w-0 max-w-[220px] items-center gap-2 border-r border-hairline pl-2.5 pr-2 text-ui text-muted-foreground hover:bg-fill-hover data-active:bg-surface data-active:text-foreground"
          >
            {tab.file ? <FileCodeIcon className="size-3.5 shrink-0 text-faint" /> : <LiveMark harness={tab.harness!} state={tab.state!} lit={Boolean(selected(tab))} cut={selected(tab) ? "var(--surface)" : "var(--shell)"} />}
            <span className="min-w-0 truncate">{tab.title}</span>
            <XIcon className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100 group-data-active:opacity-100" />
          </button>
        ))}
        <button type="button" aria-label="New tab" className="pressable flex w-9 items-center justify-center text-faint hover:text-foreground">
          <PlusIcon className="size-4" />
        </button>
      </div>
      <button type="button" aria-label="Show the side panel" className="pressable flex w-10 items-center justify-center text-faint hover:text-foreground">
        <PanelRightIcon className="size-4" />
      </button>
    </div>
  )
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-label text-muted-foreground hover:bg-fill-hover", className)}>{children}</span>
}

function Header({ crumb, title, harness, earlier, model, branch, changes, pr, fins, counts, place }: { crumb?: ReactNode; title: string; harness: string; earlier?: string[]; model: string; branch: string; changes?: [number, number]; pr?: number; fins?: boolean; counts?: Rollup; place: string }) {
  return (
    <header className="shrink-0 border-b border-hairline px-6 pb-2.5 pt-3.5">
      {crumb}
      <div className="flex items-center gap-3">
        <h1 className="min-w-0 flex-1 truncate text-title font-semibold text-foreground">{title}</h1>
        {pr ? (
          <button type="button" className="pressable flex h-7 items-center gap-1.5 rounded-md px-2 text-label text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover">
            <GitPullRequestIcon className="size-3.5" />#{pr}
            <span className="flex items-center gap-1 text-faint"><CircleDotIcon className="size-3 text-caution" />checks running</span>
          </button>
        ) : null}
        <button type="button" className="pressable flex h-7 items-center gap-1.5 rounded-md px-2 text-label text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover">
          <PlayIcon className="size-3" />Run app
        </button>
      </div>
      <div className="-ml-1.5 mt-1.5 flex min-w-0 items-center gap-0.5 overflow-hidden">
        <Chip>
          {earlier?.map((name) => <HarnessIcon key={name} harness={name} className="size-3 opacity-40" />)}
          {earlier?.length ? <ChevronRightIcon className="-mx-0.5 size-3 text-faint" /> : null}
          <HarnessIcon harness={harness} className="size-3.5" />
          <span className="text-foreground/85">{harnessLabel(harness)}</span>
          <span className="text-faint">{model}</span>
          <ChevronDownIcon className="size-3 text-faint" />
        </Chip>
        <span className="text-faint/60">·</span>
        <Chip>
          <GitBranchIcon className="size-3.5" />
          <span className="text-foreground/85">{branch}</span>
          {changes ? <span className="tabular"><span className="text-added">+{changes[0]}</span> <span className="text-removed">−{changes[1]}</span></span> : null}
        </Chip>
        <span className="text-faint/60">·</span>
        <Chip>
          <LaptopIcon className="size-3.5" />
          {place}
        </Chip>
        {fins && counts ? (
          <>
            <span className="text-faint/60">·</span>
            <Chip>
              <ApexMark className="size-3.5" />
              <span className="text-foreground/85">{rollupLine(counts)}</span>
            </Chip>
          </>
        ) : null}
      </div>
    </header>
  )
}

function You({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[78%] rounded-xl rounded-br-md bg-raised px-3.5 py-2 text-prose leading-[1.55] text-foreground">{children}</p>
    </div>
  )
}

function Says({ harness, children }: { harness: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-label text-faint">
        <HarnessIcon harness={harness} className="size-3" />
        {harnessLabel(harness)}
      </span>
      <div className="mako-prose text-prose leading-[1.65] text-foreground">{children}</div>
    </div>
  )
}

function Event({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 text-label text-faint"><CornerDownRightIcon className="size-3.5" />{children}</p>
}

/** A transcript held at its end, as a chat is. */
export function useEnd<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const crew = element.querySelector<HTMLElement>("[data-crew]")
    element.scrollTop = crew ? crew.offsetTop - element.offsetTop - 96 : element.scrollHeight
  })
  return ref
}

export function Composer({ placeholder, harness, model }: { placeholder: string; harness: string; model: string }) {
  return (
    <div className="shrink-0 px-6 pb-4 pt-2">
      <div className="mx-auto max-w-[var(--container-content)] rounded-xl bg-surface p-2 shadow-[inset_0_0_0_1px_var(--border)]">
        <p className="px-2 pb-6 pt-1.5 text-ui text-faint">{placeholder}</p>
        <div className="flex items-center gap-1">
          <span className="flex size-7 items-center justify-center rounded-md text-faint"><PlusIcon className="size-4" /></span>
          <Chip><HarnessIcon harness={harness} className="size-3.5" /><span className="font-medium text-foreground/85">{model}</span><span className="text-faint">High</span></Chip>
          <Chip><ShieldIcon className="size-3.5" />Ask before acting</Chip>
          <span className="flex-1" />
          <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background"><ArrowUpIcon className="size-4" /></span>
        </div>
      </div>
    </div>
  )
}

export function ApexView({ fins, counts, onAnswer, onOpenFin }: { fins: Fin[]; counts: Rollup; onAnswer: (fin: Fin, option: number) => void; onOpenFin: (fin: Fin) => void }) {
  const end = useEnd<HTMLDivElement>()
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <Header title={APEX.title} harness="claude" model="Opus 5.5" branch="mobile-polish" changes={[214, 38]} pr={318} fins counts={counts} place="This Mac" />
      <div ref={end} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[var(--container-content)] flex-col gap-5 px-6 py-6">
          <You>Split the phone polish list into Threads and see them through. Ask me only for what you can't decide.</You>
          <Says harness="claude">Twelve pieces, each its own Thread on the harness that suits it. I'll start them as the tree allows and read their reports as they come.</Says>
          <You>The sheet still jumps when the keyboard opens in split view.</You>
          <Event>Passed on to Sheet motion on iPad, which takes it at its next step</Event>
          <Says harness="claude">That's Sheet motion's: it's measuring the container in split view now. Two Fins need a word from you; the rest are moving.</Says>
          <CrewCard fins={fins} counts={counts} apex={APEX.title} onAnswer={onAnswer} onOpen={onOpenFin} />
        </div>
      </div>
      <Composer placeholder="Message Mobile polish. It passes your words to the right Fin" harness="claude" model="Opus 5.5" />
    </div>
  )
}

export function FinView({ fin, onBack, onAnswer }: { fin: Fin; onBack: () => void; onAnswer: (fin: Fin, option: number) => void }) {
  const ask = fin.state.kind === "blocked" ? fin.state.ask : undefined
  const end = useEnd<HTMLDivElement>()
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <Header
        crumb={
          <button type="button" onClick={onBack} className="pressable -ml-1 mb-1 flex items-center gap-1.5 rounded px-1 text-label text-faint hover:text-foreground">
            <ApexMark className="size-3.5" />Mobile polish<ChevronRightIcon className="size-3" /><span className="text-muted-foreground">Fin</span>
          </button>
        }
        title={fin.agent.title}
        harness={fin.agent.provider}
        model={fin.agent.model ?? ""}
        branch={fin.name}
        changes={[38, 12]}
        place="This Mac"
      />
      <div ref={end} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[var(--container-content)] flex-col gap-5 px-6 py-6">
          <div className="rounded-xl bg-raised/60 px-4 py-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
            <p className="mb-1 flex items-center gap-1.5 text-label text-faint"><ApexMark className="size-3.5" />Brief from Mobile polish</p>
            <p className="text-ui text-foreground/90">{fin.agent.detail}</p>
          </div>
          <Says harness={fin.agent.provider}>The sheet animates from its own height, so in split view it starts off screen. I'll measure the container instead, then run the iPad case.</Says>
          <Event>Mobile polish passed on your words: "The sheet still jumps when the keyboard opens in split view."</Event>
          {ask?.kind === "approval" ? (
            <div className="rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--caution)_35%,transparent)]">
              <p className="flex items-center gap-2 text-ui font-medium text-foreground"><LiveMark harness={fin.agent.provider} state="needs" cut="var(--surface)" />Approve <code className="rounded-sm bg-raised px-1 font-mono text-code">npm ci</code></p>
              <p className="mt-1 pl-7 text-label text-faint">Installs the locked packages in this Fin's worktree. Mobile polish can't approve this for you.</p>
              <div className="mt-2.5 flex gap-1.5 pl-7">
                {(ask.options ?? []).map((option, index) => (
                  <button key={option.label} type="button" onClick={() => onAnswer(fin, index)} className={cn("pressable h-7 rounded-md px-2.5 text-label font-medium", index === 0 ? "bg-foreground text-background" : "text-foreground/85 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover")}>
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <Composer placeholder={`Message ${fin.agent.title}. Mobile polish hears it too`} harness={fin.agent.provider} model={fin.agent.model ?? ""} />
    </div>
  )
}

export function InboxView({ asks, fins, onAnswer, onOpenFin }: { asks: Ask[]; fins: Fin[]; onAnswer: (fin: Fin, option: number) => void; onOpenFin: (fin: Fin) => void }) {
  const unread = THREADS.filter((thread) => thread.mark === "unread")
  const failed = THREADS.filter((thread) => thread.mark === "failed")
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="shrink-0 border-b border-hairline px-6 pb-3 pt-4">
        <h1 className="text-title font-semibold text-foreground">Inbox</h1>
        <p className="mt-0.5 text-label text-muted-foreground">{asks.length} need you · {unread.length} answer to read · {failed.length} failed</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[var(--container-content)] flex-col gap-6 px-6 py-6">
          <section className="flex flex-col gap-2">
            <h2 className="text-label font-medium text-caution">Needs you</h2>
            {asks.map((ask) => {
              const fin = fins.find((candidate) => candidate.agent.nativeId === ask.id)
              const order = ask.options.map((_, index) => index).sort((left, right) => (left === ask.recommended ? -1 : right === ask.recommended ? 1 : 0))
              return (
                <article key={ask.id} className="rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-fill-hover/50">
                  <p className="flex items-center gap-2 text-label text-faint">
                    <LiveMark harness={ask.harness} state="needs" cut="var(--surface)" />
                    {ask.fin ? (
                      <>
                        <span className="flex items-center gap-1"><ApexMark className="size-3" />{ask.thread}</span>
                        <ChevronRightIcon className="size-3" />
                        <span className="text-foreground/85">{ask.fin}</span>
                      </>
                    ) : (
                      <span className="text-foreground/85">{ask.thread}</span>
                    )}
                    <span>· {harnessLabel(ask.harness)}</span>
                    <span className="ml-auto tabular">{ask.age}</span>
                  </p>
                  <p className="mt-1.5 pl-7 text-ui text-foreground">{ask.question}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-7">
                    {order.map((index) => {
                      const option = ask.options[index]!
                      return (
                        <button key={option.label} type="button" onClick={() => fin && onAnswer(fin, index)} className={cn("pressable flex h-7 items-center gap-1.5 rounded-md px-2.5 text-label font-medium", index === order[0] ? "bg-foreground text-background" : "text-foreground/85 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover")}>
                          {option.label}
                          {index === ask.recommended ? <span className={cn("font-normal", index === order[0] ? "text-background/70" : "text-faint")}>Recommended</span> : null}
                        </button>
                      )
                    })}
                    {fin ? <button type="button" onClick={() => onOpenFin(fin)} className="pressable ml-auto text-label text-faint hover:text-foreground">Open</button> : null}
                  </div>
                </article>
              )
            })}
          </section>
          <section className="flex flex-col gap-1">
            <h2 className="mb-1 text-label font-medium text-muted-foreground">To read</h2>
            {[...unread, ...failed].map((thread) => (
              <div key={thread.id} className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-fill-hover">
                <LiveMark harness={thread.harness} state={thread.mark} cut="var(--surface)" />
                <span className="shrink-0 text-ui text-foreground">{thread.title}</span>
                <span className="min-w-0 flex-1 truncate text-label text-faint">{thread.line}</span>
                <span className="tabular text-label text-faint">{thread.age}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
