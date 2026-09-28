import { FolderGit2Icon } from "lucide-react"
import "@/index.css"
import { AppChipButton, AppPanel, type AppView } from "@/components/stage/app-chip"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { TooltipProvider } from "@/components/ui/tooltip"

const now = Date.UTC(2026, 8, 28, 9, 0)
const minute = 60_000
const recipe = { file: ".mako/environment.json", overrides: false }
const url = "http://fix-login-redirect.thread.localhost:20140"
const web = { name: "web", port: 20140, memoryBytes: 212 * 1024 ** 2 }
const api = { name: "api", port: 20141, memoryBytes: 148 * 1024 ** 2 }
const worker = { name: "worker", memoryBytes: 61 * 1024 ** 2 }
const checks = [
  { name: "Types", state: "passed", at: now - 4 * minute },
  { name: "Unit tests", state: "passed", at: now - 4 * minute, summary: "412 passed" },
  { name: "Sign-in flow", state: "never" },
] as const

const states: { name: string; view: AppView }[] = [
  { name: "No recipe yet", view: { state: "none", processes: [], checks: [], idleStopHours: 6 } },
  { name: "Set up, stopped", view: { state: "stopped", url, processes: [], checks: [...checks], recipe, idleStopHours: 6 } },
  { name: "Installing after the lockfile changed", view: { state: "preparing", url, processes: [], checks: [...checks], recipe, prepare: { command: "npm ci", reason: "package-lock.json changed" }, idleStopHours: 6 } },
  { name: "Starting", view: { state: "starting", url, startedAt: now - 8_000, processes: [{ ...web, state: "starting" }, { ...api, state: "running" }, { ...worker, state: "running" }], checks: [...checks], recipe, idleStopHours: 6 } },
  { name: "Running, checks passed", view: { state: "running", url, startedAt: now - 12 * minute, processes: [{ ...web, state: "running" }, { ...api, state: "running" }, { ...worker, state: "running" }], checks: [...checks], recipe: { ...recipe, overrides: true }, idleStopHours: 6 } },
  { name: "Running, a check failed", view: { state: "running", url, startedAt: now - 31 * minute, processes: [{ ...web, state: "running" }, { ...api, state: "running" }], checks: [{ name: "Types", state: "passed", at: now - 2 * minute }, { name: "Unit tests", state: "failed", at: now - 2 * minute, summary: "2 of 412 failed" }, { name: "Sign-in flow", state: "running" }], recipe, idleStopHours: 6 } },
  { name: "Crashed", view: { state: "crashed", url, startedAt: now - 5 * minute, processes: [{ ...web, state: "running" }, { ...api, state: "crashed", memoryBytes: undefined, exit: { code: 1, afterMs: 4_000 }, logTail: ["Error: connect ECONNREFUSED 127.0.0.1:5432", "    at TCPConnectWrap.afterConnect (node:net:1611:16)", "Database isn't running. Start it with `npm run db`."] }], checks: [...checks], recipe, idleStopHours: 6 } },
  { name: "Waiting for room", view: { state: "waiting", url, processes: [], checks: [], recipe, room: [{ thread: "Migrate billing to v2", memoryBytes: 1.4 * 1024 ** 3, quietMs: 52 * minute }, { thread: "Old experiment", memoryBytes: 612 * 1024 ** 2, quietMs: 3 * 60 * minute }], idleStopHours: 6 } },
]

function Strip({ view }: { view: AppView }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-hairline bg-shell pr-1">
      <div className="flex min-w-0 flex-1 items-center px-2">
        <div className="flex h-7 w-56 min-w-16 items-center gap-1.5 rounded-md bg-raised px-1.5 text-ui font-medium text-foreground">
          <HarnessIcon harness="codex" className="size-4" />
          <span className="truncate">Fix the login redirect</span>
        </div>
      </div>
      <AppChipButton view={view} data-state="open" />
      <span className="mx-0.5 h-3.5 w-px bg-hairline" />
      <span className="flex h-6 items-center gap-1 rounded-md px-1.5 text-label text-faint">
        <FolderGit2Icon className="size-3" />fix-login-redirect
      </span>
    </div>
  )
}

function Frame({ name, view }: { name: string; view: AppView }) {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="px-1 text-label text-faint">{name}</figcaption>
      <div className="overflow-hidden rounded-lg bg-surface ring-1 ring-hairline">
        <Strip view={view} />
        <div className="relative flex h-full min-h-[420px] justify-end bg-surface p-2 pr-24">
          <div className="overlay-panel h-fit text-ui" style={{ width: view.state === "none" ? 320 : 368 }}>
            <AppPanel view={view} now={now} on={() => {}} />
          </div>
        </div>
      </div>
    </figure>
  )
}

export function Gallery() {
  const only = new URLSearchParams(location.search).get("only")
  const shown = only ? states.filter((_, index) => String(index) === only) : states
  return (
    <TooltipProvider>
      <main className={only ? "w-[600px] bg-shell p-4" : "grid grid-cols-2 gap-6 bg-shell p-6"}>
        {shown.map((entry) => <Frame key={entry.name} {...entry} />)}
      </main>
    </TooltipProvider>
  )
}
