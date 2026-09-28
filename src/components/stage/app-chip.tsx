import type { ReactNode } from "react"
import { AppWindowIcon, CheckIcon, FileCogIcon, LoaderCircleIcon, PlayIcon, RotateCwIcon, ScrollTextIcon, SparklesIcon, SquareArrowOutUpRightIcon, SquareIcon, XIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Action, IconAction } from "@/components/ui/kit"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * One Thread's own copy of the project's app, as its strip shows it. `none`
 * is a project without a recipe; `waiting` is a start Mako refused because
 * the Mac is short on memory.
 */
export type AppState = "none" | "stopped" | "preparing" | "starting" | "running" | "crashed" | "waiting"

export interface AppProcessView {
  name: string
  state: "running" | "starting" | "crashed" | "stopped"
  port?: number
  memoryBytes?: number
  exit?: { code: number | null; afterMs: number }
  logTail?: string[]
}

export interface AppCheckView {
  name: string
  state: "passed" | "failed" | "running" | "never"
  at?: number
  summary?: string
}

export interface AppView {
  state: AppState
  url?: string
  startedAt?: number
  processes: AppProcessView[]
  checks: AppCheckView[]
  prepare?: { command: string; reason: string }
  room?: { thread: string; memoryBytes: number; quietMs: number }[]
  recipe?: { file: string; overrides: boolean }
  idleStopHours: number
}

export type AppAction =
  | { kind: "start" | "stop" | "restart" | "open" | "copy-url" | "setup" | "not-here" | "edit-recipe" | "retry" }
  | { kind: "logs" | "run-check" | "fix"; name: string }
  | { kind: "stop-other"; thread: string }

function bytes(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
}

function quiet(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `unused for ${minutes} min`
  const hours = Math.round(minutes / 60)
  return `unused for ${hours} ${hours === 1 ? "hour" : "hours"}`
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`
}

function Dot({ state, className }: { state: AppState | AppProcessView["state"]; className?: string }) {
  return (
    <span
      aria-hidden
      data-app-dot={state}
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        state === "running" && "bg-positive shadow-[0_0_0_3px_color-mix(in_oklab,var(--positive)_20%,transparent)]",
        state === "starting" && "bg-caution",
        state === "crashed" && "bg-negative shadow-[0_0_0_3px_color-mix(in_oklab,var(--negative)_20%,transparent)]",
        (state === "stopped" || state === "none") && "ring-1 ring-faint ring-inset",
        state === "waiting" && "ring-1 ring-caution ring-inset",
        className
      )}
    >
      {state === "starting" ? <span className="absolute inset-0 animate-ping rounded-full bg-caution opacity-60 motion-reduce:hidden" /> : null}
    </span>
  )
}

function mainPort(view: AppView): number | undefined {
  return view.processes.find((process) => process.port !== undefined)?.port
}

function chipLabel(view: AppView): ReactNode {
  switch (view.state) {
    case "none": return <><AppWindowIcon className="size-3 shrink-0" />Set up app</>
    case "stopped": return <><Dot state="stopped" />App</>
    case "preparing": return <><LoaderCircleIcon className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />Installing</>
    case "starting": return <><Dot state="starting" />Starting</>
    case "crashed": return <><Dot state="crashed" /><span className="text-negative">App crashed</span></>
    case "waiting": return <><Dot state="waiting" />Waiting for room</>
    case "running": {
      const port = mainPort(view)
      return <><Dot state="running" />App{port ? <span className="font-mono text-code tabular-nums opacity-80">:{port}</span> : null}</>
    }
  }
}

function CheckMark({ checks }: { checks: AppCheckView[] }) {
  const failed = checks.filter((check) => check.state === "failed").length
  const ran = checks.filter((check) => check.state === "passed" || check.state === "failed").length
  if (checks.some((check) => check.state === "running"))
    return <LoaderCircleIcon aria-label="Checks running" className="size-3 animate-spin motion-reduce:animate-none" />
  if (failed) return <span className="flex items-center gap-0.5 text-negative"><XIcon className="size-3" />{failed}</span>
  if (ran) return <CheckIcon aria-label="Checks passed" className="size-3 text-positive" />
  return null
}

function chipSentence(view: AppView): string {
  const port = mainPort(view)
  const failed = view.checks.filter((check) => check.state === "failed").length
  const state = {
    none: "This project's app isn't set up for Threads",
    stopped: "This Thread's app is stopped",
    preparing: "Installing dependencies before the app starts",
    starting: "This Thread's app is starting",
    running: `This Thread's app is running${port ? ` on port ${port}` : ""}`,
    crashed: "This Thread's app crashed",
    waiting: "Waiting for memory to start this Thread's app",
  }[view.state]
  return failed ? `${state}, ${failed} ${failed === 1 ? "check" : "checks"} failed` : state
}

const eyebrow = "px-3 pt-2.5 pb-1 text-label font-medium text-faint"
const row = "group/row flex min-h-8 items-center gap-2.5 rounded-md px-3 py-1 hover:bg-fill-hover"
const reveal = "opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100"

function Header({ view, now, on }: { view: AppView; now: number; on: (action: AppAction) => void }) {
  const memory = bytes(view.processes.reduce((sum, process) => sum + (process.memoryBytes ?? 0), 0) || undefined)
  const title = { none: "", stopped: "Stopped", preparing: "Installing", starting: "Starting", running: "Running", crashed: "Crashed", waiting: "Waiting for room" }[view.state]
  const detail =
    view.state === "running" ? [view.startedAt ? `Started ${ago(now - view.startedAt)}` : "", memory].filter(Boolean).join(" · ")
    : view.state === "preparing" && view.prepare ? `${view.prepare.command} · ${view.prepare.reason}`
    : view.state === "starting" ? "Waiting for the app to answer"
    : view.state === "stopped" ? `Starts on this Thread's own port`
    : view.state === "waiting" ? "Your Mac is short on memory"
    : ""
  const live = view.state === "running" || view.state === "starting" || view.state === "preparing"
  const leftRunning = view.state === "crashed" && view.processes.some((process) => process.state === "running")
  return (
    <div className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
      <Dot state={view.state} className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium text-foreground">{title}</p>
        {detail ? <p className="truncate text-label text-faint">{detail}</p> : null}
      </div>
      {live ? (
        <div className="-mt-0.5 -mr-1.5 flex items-center">
          <IconAction label="Restart" size="xs" onClick={() => on({ kind: "restart" })}><RotateCwIcon /></IconAction>
          <IconAction label={`Stop · stops by itself after ${view.idleStopHours} h unused`} size="xs" onClick={() => on({ kind: "stop" })}><SquareIcon /></IconAction>
        </div>
      ) : leftRunning ? (
        <IconAction label="Stop the rest" size="xs" className="-mt-0.5 -mr-1.5" onClick={() => on({ kind: "stop" })}><SquareIcon /></IconAction>
      ) : view.state === "stopped" ? (
        <Action tone="solid" size="xs" className="-mt-0.5 px-2.5 text-label" onClick={() => on({ kind: "start" })}><PlayIcon className="fill-current" />Start</Action>
      ) : null}
    </div>
  )
}

function Address({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  if (!view.url) return null
  const ready = view.state === "running"
  const address = new URL(view.url)
  const [name, ...rest] = address.hostname.split(".")
  return (
    <div className="mx-2 mb-1 flex items-center gap-1 rounded-lg bg-raised p-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => on({ kind: "copy-url" })}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-label tabular-nums hover:bg-fill-hover"
          >
            {/* The Thread's own name leads; the shared suffix gives way first. */}
            <span className={cn("shrink-0", ready ? "text-foreground" : "text-muted-foreground")}>{name}</span>
            <span className="-ml-1.5 min-w-0 truncate text-faint">.{rest.join(".")}</span>
            <span className={cn("-ml-1.5 shrink-0", ready ? "text-muted-foreground" : "text-faint")}>:{address.port}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Copy address</TooltipContent>
      </Tooltip>
      <Action tone="outline" size="xs" disabled={!ready} className="gap-1 bg-popover px-2 text-label" onClick={() => on({ kind: "open" })}>
        Open<SquareArrowOutUpRightIcon className="size-3!" />
      </Action>
    </div>
  )
}

function Crash({ process, on }: { process: AppProcessView; on: (action: AppAction) => void }) {
  const code = process.exit?.code
  return (
    <div className="mx-2 mb-1 overflow-hidden rounded-lg bg-negative/8 ring-1 ring-negative/20 ring-inset">
      <p className="px-2.5 pt-2 text-label text-foreground">
        <span className="font-medium">{process.name}</span>
        <span className="text-muted-foreground"> exited{code !== undefined && code !== null ? ` with code ${code}` : ""}{process.exit ? ` after ${seconds(process.exit.afterMs)}` : ""}</span>
      </p>
      {process.logTail?.length ? (
        <pre className="mx-2.5 mt-1.5 overflow-hidden rounded-md bg-shell/70 px-2 py-1.5 font-mono text-code leading-4 whitespace-pre-wrap text-muted-foreground">
          {process.logTail.join("\n")}
        </pre>
      ) : null}
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <Action tone="quiet" size="xs" className="text-label" onClick={() => on({ kind: "fix", name: process.name })}><SparklesIcon />Ask the agent to fix it</Action>
        <span className="flex-1" />
        <Action tone="ghost" size="xs" className="text-label" onClick={() => on({ kind: "logs", name: process.name })}>Logs</Action>
        <Action tone="ghost" size="xs" className="text-label" onClick={() => on({ kind: "restart" })}><RotateCwIcon />Restart</Action>
      </div>
    </div>
  )
}

function Processes({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  if (view.processes.length < 2 && view.state !== "running") return null
  return (
    <section>
      <p className={eyebrow}>Processes</p>
      {view.processes.map((process) => (
        <div key={process.name} className={row}>
          <Dot state={process.state} />
          <span className="min-w-0 flex-1 truncate text-ui text-foreground">{process.name}</span>
          <span className={cn(reveal, "-my-1")}>
            <IconAction label={`Logs of ${process.name}`} size="xs" onClick={() => on({ kind: "logs", name: process.name })}><ScrollTextIcon /></IconAction>
          </span>
          <span className="w-14 text-right text-label text-faint tabular-nums">{bytes(process.memoryBytes) ?? ""}</span>
          <span className="w-12 text-right font-mono text-code text-faint tabular-nums">{process.port ? `:${process.port}` : ""}</span>
        </div>
      ))}
    </section>
  )
}

function CheckIconFor({ check }: { check: AppCheckView }) {
  switch (check.state) {
    case "passed": return <CheckIcon className="size-3.5 shrink-0 text-positive" />
    case "failed": return <XIcon className="size-3.5 shrink-0 text-negative" />
    case "running": return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-faint motion-reduce:animate-none" />
    case "never": return <span className="flex size-3.5 shrink-0 items-center justify-center"><span className="size-1 rounded-full bg-faint/60" /></span>
  }
}

function Checks({ view, now, on }: { view: AppView; now: number; on: (action: AppAction) => void }) {
  if (!view.checks.length) return null
  return (
    <section>
      <p className={eyebrow}>Checks</p>
      {view.checks.map((check) => {
        const when = check.at ? ago(now - check.at) : undefined
        const result =
          check.state === "running" ? "Running…"
          : check.state === "never" ? "Not run on this Thread yet"
          : [check.summary ?? (check.state === "passed" ? "Passed" : "Failed"), when].filter(Boolean).join(" · ")
        return (
          <div key={check.name} className={row}>
            <CheckIconFor check={check} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui text-foreground">{check.name}</p>
              <p className={cn("truncate text-label", check.state === "failed" ? "text-negative/90" : "text-faint")}>{result}</p>
            </div>
            <span className={cn("-my-1 flex items-center", check.state !== "failed" && reveal)}>
              {check.state === "failed" ? (
                <IconAction label="Ask the agent to fix it" size="xs" onClick={() => on({ kind: "fix", name: check.name })}><SparklesIcon /></IconAction>
              ) : null}
              {check.state === "passed" || check.state === "failed" ? (
                <IconAction label={`Output of ${check.name}`} size="xs" onClick={() => on({ kind: "logs", name: check.name })}><ScrollTextIcon /></IconAction>
              ) : null}
              {check.state !== "running" ? (
                <IconAction label={`Run ${check.name}`} size="xs" onClick={() => on({ kind: "run-check", name: check.name })}><PlayIcon /></IconAction>
              ) : null}
            </span>
          </div>
        )
      })}
    </section>
  )
}

function Room({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  return (
    <section>
      <p className="px-3 pb-1.5 text-label text-muted-foreground">
        Mako starts this app once there's room. Stopping one of these frees it now:
      </p>
      {view.room?.map((other) => (
        <div key={other.thread} className={row}>
          <Dot state="running" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui text-foreground">{other.thread}</p>
            <p className="truncate text-label text-faint">{bytes(other.memoryBytes)} · {quiet(other.quietMs)}</p>
          </div>
          <Action tone="outline" size="xs" className="text-label" onClick={() => on({ kind: "stop-other", thread: other.thread })}>Stop</Action>
        </div>
      ))}
      <div className="px-2 pt-1">
        <Action tone="ghost" size="xs" className="w-full text-label" onClick={() => on({ kind: "retry" })}><RotateCwIcon />Try again</Action>
      </div>
    </section>
  )
}

function Footer({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  if (!view.recipe) return null
  return (
    <div className="mt-1.5 flex items-center gap-2 border-t border-hairline px-3 pt-2 pb-2">
      <p className="min-w-0 flex-1 truncate text-label text-faint">
        <span className="font-mono text-code">{view.recipe.file}</span>
        {view.recipe.overrides ? " + your overrides" : ""}
      </p>
      <IconAction label="Edit the recipe" size="xs" className="-mr-1.5" onClick={() => on({ kind: "edit-recipe" })}><FileCogIcon /></IconAction>
    </div>
  )
}

function SetUp({ on }: { on: (action: AppAction) => void }) {
  return (
    <div className="p-3">
      <div className="mb-2.5 flex size-8 items-center justify-center rounded-lg bg-raised text-muted-foreground ring-1 ring-hairline ring-inset">
        <AppWindowIcon className="size-4" />
      </div>
      <p className="text-ui font-medium text-foreground">Run this app in every Thread</p>
      <p className="mt-1 text-label text-muted-foreground">
        Each Thread gets its own copy on its own port and data, so agents can open and check their work side by side without stepping on each other.
      </p>
      <p className="mt-2 text-label text-faint">
        An agent works out how this project runs, writes <span className="font-mono text-code">.mako/environment.json</span> on this branch, and proves it starts before you merge it.
      </p>
      <div className="mt-3 flex items-center gap-1.5">
        <Action tone="solid" size="sm" className="text-label" onClick={() => on({ kind: "setup" })}><SparklesIcon />Set it up with an agent</Action>
        <Action tone="ghost" size="sm" className="text-label" onClick={() => on({ kind: "not-here" })}>Not for this project</Action>
      </div>
    </div>
  )
}

/** The panel the chip opens; the gallery renders it on its own. */
export function AppPanel({ view, now, on }: { view: AppView; now: number; on: (action: AppAction) => void }) {
  if (view.state === "none") return <SetUp on={on} />
  const crashed = view.processes.find((process) => process.state === "crashed")
  return (
    <div className="pb-0.5">
      <Header view={view} now={now} on={on} />
      {view.state === "waiting" ? <Room view={view} on={on} /> : (
        <>
          <Address view={view} on={on} />
          {crashed ? <Crash process={crashed} on={on} /> : null}
          <Processes view={view} on={on} />
          <Checks view={view} now={now} on={on} />
        </>
      )}
      <Footer view={view} on={on} />
    </div>
  )
}

export function AppChipButton({ view, ...props }: { view: AppView } & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-app-chip={view.state}
      aria-label={chipSentence(view)}
      className={cn(
        "pressable flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-label whitespace-nowrap transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground",
        view.state === "running" ? "text-muted-foreground" : "text-faint"
      )}
      {...props}
    >
      {chipLabel(view)}
      {view.state === "running" || view.state === "stopped" ? <CheckMark checks={view.checks} /> : null}
    </button>
  )
}

/** This Thread's app, quiet at the right of its strip beside the checkout. */
export function AppChip({ view, now, on }: { view: AppView; now: number; on: (action: AppAction) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <AppChipButton view={view} />
      </PopoverTrigger>
      <PopoverContent align="end" className={cn("gap-0 p-0 text-ui", view.state === "none" ? "w-80" : "w-[23rem]")}>
        <AppPanel view={view} now={now} on={on} />
      </PopoverContent>
    </Popover>
  )
}
