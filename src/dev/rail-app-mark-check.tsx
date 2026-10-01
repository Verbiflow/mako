import type { ReactNode } from "react"
import { FolderGit2Icon, FolderOpenIcon, HourglassIcon, LoaderCircleIcon, PlayIcon, TriangleAlertIcon } from "lucide-react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ActivityMark } from "@/components/ui/activity-mark"
import { cn } from "@/lib/utils"

/**
 * Where the sidebar says a Thread's app is running, on the rail's own
 * classes, for choosing before the rail changes: the strip's own app icons,
 * beside words in place of the time. Served by `scripts/rail-app-mark.html`;
 * `?theme=light` for the light theme.
 */

type App = "running" | "starting" | "waiting" | "crashed"
type Row = { title: string; harness: string; worktree: boolean; working?: boolean; app?: App; time: string; tip: string }

const ROWS: Row[] = [
  { title: "Fix checkout totals", harness: "claude", worktree: true, app: "running", time: "4m", tip: "App running at fix-checkout-totals.thread.localhost:20180" },
  { title: "Add order history page", harness: "codex", worktree: true, working: true, app: "running", time: "now", tip: "App running at add-order-history.thread.localhost:20190" },
  { title: "Seed demo accounts", harness: "claude", worktree: true, app: "starting", time: "now", tip: "App starting" },
  { title: "Update payment copy", harness: "cursor", worktree: true, app: "crashed", time: "12m", tip: "App crashed (exit 1) 3m ago. Open the Thread for its log." },
  { title: "Bump dependencies", harness: "opencode", worktree: true, app: "waiting", time: "1m", tip: "App waiting for memory; it starts by itself once there's room" },
  { title: "Explain the cart reducer", harness: "grok", worktree: false, time: "2h", tip: "Uses the project folder's app" },
  { title: "Refactor search ranking", harness: "devin", worktree: true, time: "1d", tip: "No app running" },
]

const WORDS = { running: "App running", starting: "App starting", waiting: "App waiting", crashed: "App crashed" } satisfies Record<App, string>

/** The strip's own icon for each state (`TriggerIcon` in `app-control.tsx`), at the rail's 12px. */
function AppIcon({ app }: { app: App }) {
  const icon = "size-3 shrink-0"
  const mark =
    app === "running" ? <PlayIcon className={cn(icon, "fill-current text-positive")} strokeWidth={2.5} />
    : app === "starting" ? <LoaderCircleIcon className={cn(icon, "animate-spin text-faint")} strokeWidth={2.5} />
    : app === "waiting" ? <HourglassIcon className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />
    : <TriangleAlertIcon className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />
  return <span data-app-mark={app} role="img" aria-label={WORDS[app]} className="flex shrink-0 items-center">{mark}</span>
}

function AppWords({ app }: { app: App }) {
  return <span data-app-mark={app} className={cn("shrink-0 text-label", app === "crashed" ? "text-muted-foreground" : "text-faint")}>{WORDS[app]}</span>
}

function Time({ value }: { value: string }) {
  return <span className="tabular shrink-0 text-label text-faint">{value}</span>
}

function Working() {
  return <span className="flex shrink-0 items-center text-muted-foreground"><ActivityMark state="working" size={20} /></span>
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

function Header({ trailing }: { trailing: ReactNode }) {
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
      <span>2 running</span>
    </span>
  )
}

/** The icon sits before the row's time or orb, so nothing else moves. */
function IconOption() {
  return (
    <>
      <Header trailing={<span className="flex items-center gap-2"><AppIcon app="running" /><FolderRunning /></span>} />
      <div className="ml-[13px] border-l border-hairline pl-1">
        {ROWS.map((row) => (
          <RowShell key={row.title} row={row}>
            {row.app ? <AppIcon app={row.app} /> : null}
            {row.working ? <Working /> : <Time value={row.time} />}
          </RowShell>
        ))}
      </div>
    </>
  )
}

/** Words in place of the time, for comparison. */
function WordsOption() {
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

const OPTIONS = [
  { id: "icon", name: "Icon", note: "The strip's own app icons: running, starting, waiting for memory, crashed. Each row keeps its time and its orb; hovering names the state and the address. The project folder's own app shows on its header.", body: <IconOption /> },
  { id: "words", name: "Words, for comparison", note: "The same states in words, in place of the time. A working row keeps its orb and loses its app; the header can't fit both.", body: <WordsOption /> },
]

export function RailAppMarkPage() {
  return (
    <div className="min-h-svh bg-shell p-8 text-foreground">
      <h1 className="text-ui font-medium">Sidebar: which Threads have their app running</h1>
      <p className="mt-1 max-w-[40rem] text-label text-muted-foreground">
        The same seven Threads under each option. Five have an app of their own: running, running while the agent works, starting, crashed, and waiting for memory. One uses the project folder's app, which is running, and one has none. Nothing shows for a Thread with no app.
      </p>
      <div className="mt-6 flex gap-8">
        {OPTIONS.map((option) => (
          <section key={option.id} data-option={option.id} className="w-[264px] shrink-0">
            <h2 className="mb-1 text-ui font-medium text-foreground">{option.name}</h2>
            <p className="mb-3 min-h-[6rem] text-label text-muted-foreground">{option.note}</p>
            <div className="overflow-hidden rounded-lg border border-hairline bg-shell py-1 pr-1 pl-1.5">{option.body}</div>
          </section>
        ))}
      </div>
    </div>
  )
}
