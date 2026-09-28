import { AppWindowIcon, FilesIcon, FolderGit2Icon, GitBranchIcon, GitCompareIcon, MonitorIcon } from "lucide-react"
import { AppPanelView, type AppView, type LogLine } from "@/components/inspector/app-panel"
import { AppStatus } from "@/components/stage/app-status"
import { Chip } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const now = Date.UTC(2026, 8, 28, 9, 0)
const minute = 60_000
const url = "http://tighten-composer.thread.localhost:20140"
const recipe = { file: ".mako/environment.json", overrides: false }
const lines = (text: string, error?: (line: string) => boolean): LogLine[] => text.split("\n").map((line) => ({ text: line, error: error?.(line) }))

const webLog = lines(`> mako@0.0.1 dev
> npm run web

> mako@0.0.1 build:electron
> npm run prepare:kiri && npm run build:control-runtime && tsgo -b tsconfig.electron.json

  VITE v7.1.4  ready in 812 ms

  ➜  Local:   http://127.0.0.1:20140/
[mako-client] Profile thread · host 76195 · manual reload · http://tighten-composer.thread.localhost:20140/
9:02:11 AM - Starting compilation in watch mode...
9:02:14 AM - Found 0 errors. Watching for file changes.
9:08:40 AM [vite] (client) page reload src/components/composer/composer.tsx`)

const crashLog = lines(`  VITE v7.1.4  ready in 790 ms

  ➜  Local:   http://127.0.0.1:20140/
file:///…/dist-electron/dev-renderer-registration.js:34
    throw new Error("The development renderer must use a loopback URL");
          ^

Error: The development renderer must use a loopback URL
    at validate (file:///…/dist-electron/dev-renderer-registration.js:34:11)
    at publishDevRendererRegistration (file:///…/dev-renderer-registration.js:52:5)

Node.js v24.19.0`, (line) => line.startsWith("Error:") || line.includes("throw new Error"))

const quickPassed = lines(`> mako@0.0.1 typecheck
All TypeScript projects passed in separate bounded processes

> mako@0.0.1 lint
Found 0 errors in 1,284 files.`)

const quickFailed = lines(`> mako@0.0.1 typecheck
src/components/composer/composer.tsx:212:9 - error TS2322: Type 'string | undefined' is not assignable to type 'string'.

212         placeholder={draft.hint}
            ~~~~~~~~~~~

Found 1 error in src/components/composer/composer.tsx:212`, (line) => line.includes("error TS"))

const installLog = lines(`> npm ci
npm warn deprecated inflight@1.0.6: This module is not supported
npm warn deprecated rimraf@2.6.3: Rimraf versions prior to v4 are no longer supported
added 1412 packages in 38s`)

const checks = (quick: AppView["checks"][number]["state"], output = quickPassed): AppView["checks"] => [
  { tier: "quick", command: "npm run typecheck && npm run lint", state: quick, at: now - 4 * minute, output },
  { tier: "full", command: "npm run test:dev-live", state: "never", output: [] },
]
const web = { name: "web", port: 20140, memoryBytes: 642 * 1024 ** 2 }
const base = { project: "mako", recipe, idleStopHours: 6, url }

const states: { name: string; view: AppView; thread?: string }[] = [
  {
    name: "No recipe yet",
    view: {
      state: "none", project: "mako", processes: [], checks: [], idleStopHours: 6,
      found: [
        { command: "npm run web", says: "builds the host, serves the desk on 5173" },
        { command: "npm run typecheck", says: "every TypeScript project" },
        { command: "npm run lint", says: "eslint and oxlint" },
      ],
      setupWith: { harness: "Codex", model: "GPT-6 Astra, high effort" },
    },
  },
  {
    name: "Being set up in its own Thread",
    thread: "Set up the app",
    view: {
      state: "setting-up", project: "mako", processes: [], checks: [], idleStopHours: 6,
      setup: {
        thread: "Set up the app", harness: "Codex", model: "GPT-6 Astra",
        steps: [
          { label: "Learned how mako runs", state: "done" },
          { label: "Found what two copies would share", state: "done" },
          { label: "Wrote .mako/environment.json", state: "done" },
          { label: "Starting the app on its own port", state: "doing" },
          { label: "Quick and full checks", state: "todo" },
          { label: "Ready to merge", state: "todo" },
        ],
      },
    },
  },
  { name: "Stopped", view: { ...base, state: "stopped", startedAt: now - 3 * 60 * minute, processes: [{ ...web, state: "stopped", memoryBytes: undefined, log: webLog }], checks: checks("passed") } },
  { name: "Installing after the lockfile changed", view: { ...base, state: "preparing", processes: [{ ...web, state: "stopped", memoryBytes: undefined, log: [] }], checks: checks("passed"), prepare: { command: "npm ci", reason: "package-lock.json changed", log: installLog } } },
  { name: "Running", view: { ...base, state: "running", startedAt: now - 12 * minute, processes: [{ ...web, state: "running", log: webLog }], checks: checks("passed") } },
  { name: "Running, the quick check failed", view: { ...base, state: "running", startedAt: now - 31 * minute, processes: [{ ...web, state: "running", log: webLog }], checks: checks("failed", quickFailed) } },
  { name: "Crashed", view: { ...base, state: "crashed", startedAt: now - 2 * minute, processes: [{ ...web, state: "crashed", memoryBytes: undefined, exit: { code: 1, afterMs: 4_000, at: now - 2 * minute }, log: crashLog }], checks: checks("passed") } },
  { name: "Waiting for memory", view: { ...base, state: "waiting", processes: [], checks: [], room: [{ thread: "Migrate billing to v2", memoryBytes: 1.4 * 1024 ** 3, quietMs: 52 * minute }, { thread: "Old experiment", memoryBytes: 612 * 1024 ** 2, quietMs: 3 * 60 * minute }] } },
]

function Rail({ thread }: { thread: string }) {
  const rows = [thread === "Set up the app" ? undefined : thread, "Set up the app", "Read another session's transcript", "Show worktrees made outside Mako"].filter((row): row is string => Boolean(row))
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-hairline bg-shell px-2 pt-3">
      <p className="flex h-7 items-center gap-1.5 px-1.5 text-label text-faint"><FolderGit2Icon className="size-3.5" />mako</p>
      {rows.map((row) => (
        <div key={row} className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-ui", row === thread ? "bg-fill-selected text-foreground" : "text-muted-foreground")}>
          <HarnessIcon harness="codex" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{row}</span>
          {row === "Set up the app" ? <Chip className="shrink-0">Setup</Chip> : null}
        </div>
      ))}
    </aside>
  )
}

function Chat({ view, thread }: { view: AppView; thread: string }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hairline bg-shell pr-1">
        <div className="flex min-w-0 flex-1 items-center px-2">
          <div className="flex h-7 w-52 min-w-16 items-center gap-1.5 rounded-md bg-raised px-1.5 text-ui font-medium text-foreground">
            <HarnessIcon harness="codex" className="size-4" />
            <span className="truncate">{thread}</span>
          </div>
        </div>
        <AppStatus view={view} open onPanel={() => {}} onOpen={() => {}} onStart={() => {}} />
        <span className="flex h-6 items-center gap-1 rounded-md px-1.5 text-label text-faint">
          <FolderGit2Icon className="size-3" />{thread === "Set up the app" ? "set-up-the-app" : "tighten-composer"}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-8 pt-8">
        {[0.9, 0.75, 0.82, 0.4].map((width, index) => <span key={index} className="h-2 rounded-full bg-raised" style={{ width: `${width * 100}%` }} />)}
      </div>
    </section>
  )
}

function Sidebar({ view }: { view: AppView }) {
  const tabs = [
    { label: "Changes", icon: GitCompareIcon },
    { label: "Files", icon: FilesIcon },
    { label: "App", icon: AppWindowIcon },
    { label: "Control", icon: MonitorIcon },
    { label: "Agents", icon: GitBranchIcon },
  ]
  return (
    <aside className="flex w-[500px] shrink-0 flex-col border-l border-hairline bg-surface">
      <nav className="flex h-10 shrink-0 items-center gap-1.5 border-b border-hairline bg-shell px-2">
        {tabs.map((tab) => (
          <span key={tab.label} className={cn("flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 text-ui font-medium", tab.label === "App" ? "bg-raised text-foreground" : "text-faint")}>
            <tab.icon className="size-3.5 shrink-0" />
            <span className="truncate">{tab.label}</span>
          </span>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        <AppPanelView view={view} now={now} on={() => {}} />
      </div>
    </aside>
  )
}

function Frame({ name, view, thread = "Tighten the composer" }: { name: string; view: AppView; thread?: string }) {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="px-1 text-label text-faint">{name}</figcaption>
      <div className="flex h-[600px] overflow-hidden rounded-lg ring-1 ring-hairline">
        <Rail thread={thread} />
        <Chat view={view} thread={thread} />
        <Sidebar view={view} />
      </div>
    </figure>
  )
}

export function Gallery() {
  const only = new URLSearchParams(location.search).get("only")
  const shown = only ? states.filter((_, index) => String(index) === only) : states
  return (
    <TooltipProvider>
      <main className="flex w-[1180px] flex-col gap-8 bg-shell p-5">
        {shown.map((entry) => <Frame key={entry.name} {...entry} />)}
      </main>
    </TooltipProvider>
  )
}
