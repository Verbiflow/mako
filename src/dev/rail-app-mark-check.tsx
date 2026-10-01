import type { ReactNode } from "react"
import { FolderGit2Icon, FolderOpenIcon } from "lucide-react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ActivityMark } from "@/components/ui/activity-mark"
import { cn } from "@/lib/utils"

/**
 * Where the sidebar says a Thread's app is running: three placements on the
 * rail's own classes, for choosing one before the rail changes. Served by
 * `scripts/rail-app-mark.html`; `?theme=light` for the light theme.
 */

type App = "running" | "starting" | "waiting" | "crashed" | null
type Row = { title: string; harness: string; worktree: boolean; working?: boolean; app: App; time: string; tip: string }

const ROWS: Row[] = [
  { title: "Fix checkout totals", harness: "claude", worktree: true, app: "running", time: "4m", tip: "App running at fix-checkout-totals.thread.localhost:20180" },
  { title: "Add order history page", harness: "codex", worktree: true, working: true, app: "running", time: "now", tip: "App running at add-order-history.thread.localhost:20190" },
  { title: "Update payment copy", harness: "cursor", worktree: true, app: "crashed", time: "12m", tip: "App crashed (exit 1) 3m ago. Open the Thread for its log." },
  { title: "Bump dependencies", harness: "opencode", worktree: true, app: "waiting", time: "1m", tip: "App waiting for memory; it starts by itself once there's room" },
  { title: "Explain the cart reducer", harness: "grok", worktree: false, app: null, time: "2h", tip: "Uses the project folder's app" },
  { title: "Refactor search ranking", harness: "devin", worktree: true, app: null, time: "1d", tip: "No app running" },
]

const WORDS = { running: "App running", starting: "App starting", waiting: "App waiting", crashed: "App crashed" } satisfies Record<Exclude<App, null>, string>

function AppWords({ app, className }: { app: Exclude<App, null>; className?: string }) {
  return <span data-app-mark={app} className={cn("shrink-0 text-label", app === "crashed" ? "text-muted-foreground" : "text-faint", className)}>{WORDS[app]}</span>
}

function Time({ value }: { value: string }) {
  return <span className="tabular shrink-0 text-label text-faint">{value}</span>
}

function RowShell({ row, children }: { row: Row; children: ReactNode }) {
  return (
    <div data-tip={row.tip} className="group relative flex h-7 w-full items-center gap-2 rounded-md pr-1 pl-2 text-left hover:bg-fill-hover">
      <span className="flex shrink-0 items-center"><HarnessIcon harness={row.harness} className="size-3" /></span>
      <span className="min-w-0 flex-[1_1_60%] truncate text-ui text-foreground/85">{row.title}</span>
      {row.worktree ? <FolderGit2Icon className="size-3 shrink-0 text-faint/80" aria-label="In a worktree" /> : null}
      {children}
    </div>
  )
}

function Working() {
  return <span className="flex shrink-0 items-center text-muted-foreground"><ActivityMark state="working" size={20} /></span>
}

function Header({ trailing }: { trailing?: ReactNode }) {
  return (
    <div className="relative flex h-7 w-full items-center rounded-md">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-1.5">
        <span className="relative flex size-3.5 shrink-0 items-center justify-center text-faint"><FolderOpenIcon className="size-3.5" /></span>
        <span className="min-w-8 shrink truncate text-ui font-medium text-foreground">storefront</span>
        <span className="min-w-8 shrink-[4] truncate text-label text-faint/80">main</span>
        <span className="flex-1" />
        {trailing}
      </span>
    </div>
  )
}

function FolderRunning() {
  return (
    <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
      <ActivityMark state="working" size={20} />
      <span>1 running</span>
    </span>
  )
}

/** A: the app's words take the time's place; a working row keeps its orb, and the app is in its tip. */
function OptionA() {
  return (
    <>
      <Header trailing={<span className="flex items-center gap-2"><AppWords app="running" /><FolderRunning /></span>} />
      <div className="ml-[13px] border-l border-hairline pl-1">
        {ROWS.map((row) => (
          <RowShell key={row.title} row={row}>
            {row.working ? <Working /> : row.app ? <AppWords app={row.app} /> : <Time value={row.time} />}
          </RowShell>
        ))}
      </div>
    </>
  )
}

/** B: the app's words sit before whatever the row already shows. */
function OptionB() {
  return (
    <>
      <Header trailing={<span className="flex items-center gap-2"><AppWords app="running" /><FolderRunning /></span>} />
      <div className="ml-[13px] border-l border-hairline pl-1">
        {ROWS.map((row) => (
          <RowShell key={row.title} row={row}>
            {row.app ? <AppWords app={row.app} /> : null}
            {row.working ? <Working /> : <Time value={row.time} />}
          </RowShell>
        ))}
      </div>
    </>
  )
}

/** C: rows stay as they are; the project's header counts its running apps, and says when one crashed. */
function OptionC() {
  return (
    <>
      <Header trailing={<span className="flex items-center gap-2"><span className="shrink-0 text-label text-faint">3 apps</span><FolderRunning /></span>} />
      <div className="ml-[13px] border-l border-hairline pl-1">
        {ROWS.map((row) => (
          <RowShell key={row.title} row={row}>
            {row.working ? <Working /> : row.app === "crashed" ? <AppWords app="crashed" /> : <Time value={row.time} />}
          </RowShell>
        ))}
      </div>
    </>
  )
}

const OPTIONS = [
  { id: "a", name: "A. In place of the time", note: "An idle row reads its app's state instead of its time. A working row keeps its orb; hovering names the app. The project folder's own app shows on the project's header.", body: <OptionA /> },
  { id: "b", name: "B. Before the time", note: "Every row with an app says so, before its time or orb. Most informative, and titles lose about 70px.", body: <OptionB /> },
  { id: "c", name: "C. On the project only", note: "Rows change only when an app crashed. The header counts the project's running apps; hovering lists which Threads.", body: <OptionC /> },
]

export function RailAppMarkPage() {
  return (
    <div className="min-h-svh bg-shell p-8 text-foreground">
      <h1 className="text-ui font-medium">Sidebar: which Threads have their app running</h1>
      <p className="mt-1 max-w-[52rem] text-label text-muted-foreground">
        The same six Threads under each option. Four have an app of their own: running, running while the agent works, crashed, and waiting for memory. One uses the project folder's app, which is running, and one has none. Nothing shows for a Thread with no app.
      </p>
      <div className="mt-6 flex gap-8">
        {OPTIONS.map((option) => (
          <section key={option.id} data-option={option.id} className="w-[264px] shrink-0">
            <h2 className="mb-1 text-ui font-medium text-foreground">{option.name}</h2>
            <p className="mb-3 min-h-[4.5rem] text-label text-muted-foreground">{option.note}</p>
            <div className="overflow-hidden rounded-lg border border-hairline bg-shell py-1 pr-1 pl-1.5">{option.body}</div>
          </section>
        ))}
      </div>
    </div>
  )
}