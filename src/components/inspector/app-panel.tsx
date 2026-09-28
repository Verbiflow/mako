import { useState, type ReactNode } from "react"
import { AppWindowIcon, CheckIcon, CopyIcon, GlobeIcon, LoaderCircleIcon, MinusIcon, PlayIcon, RotateCwIcon, SquareArrowOutUpRightIcon, SquareIcon, XIcon } from "lucide-react"
import { Action, IconAction, ListCard } from "@/components/ui/kit"
import { cn } from "@/lib/utils"

/**
 * One Thread's own copy of the project's app, as its App tab shows it.
 * `none` is a project without a recipe; `setting-up` is a project whose
 * recipe is being written in a setup Thread; `waiting` is a start Mako
 * refused because the Mac is short on memory.
 */
export type AppState = "none" | "setting-up" | "stopped" | "preparing" | "starting" | "running" | "crashed" | "waiting"

export interface LogLine {
  text: string
  error?: boolean
}

export interface AppProcessView {
  name: string
  state: "running" | "starting" | "crashed" | "stopped"
  port?: number
  memoryBytes?: number
  exit?: { code: number | null; afterMs: number; at: number }
  log: LogLine[]
}

export interface AppCheckView {
  tier: "quick" | "full"
  command: string
  state: "passed" | "failed" | "running" | "never"
  at?: number
  output: LogLine[]
}

export interface SetupView {
  thread: string
  harness: string
  model: string
  steps: { label: string; state: "done" | "doing" | "todo" }[]
}

export interface AppView {
  state: AppState
  project: string
  url?: string
  startedAt?: number
  processes: AppProcessView[]
  checks: AppCheckView[]
  prepare?: { command: string; reason: string; log: LogLine[] }
  room?: { thread: string; memoryBytes: number; quietMs: number }[]
  recipe?: { file: string; overrides: boolean }
  /** What the project already says about running itself, for a project with no recipe. */
  found?: { command: string; says: string }[]
  /** Who a setup would go to, from the setup model setting. */
  setupWith?: { harness: string; model: string }
  setup?: SetupView
  idleStopHours: number
}

export type AppAction =
  | { kind: "start" | "stop" | "restart" | "open" | "copy-url" | "setup" | "setup-model" | "write-recipe" | "open-setup" | "edit-recipe" | "retry" }
  | { kind: "run-check"; tier: AppCheckView["tier"] }
  | { kind: "send-to-agent"; what: string }
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

function unused(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `unused for ${minutes} min`
  const hours = Math.round(minutes / 60)
  return `unused for ${hours} ${hours === 1 ? "hour" : "hours"}`
}

function duration(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`
}

export function StatusDot({ state, className }: { state: AppState | AppProcessView["state"]; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-2 shrink-0 rounded-full",
        state === "running" && "bg-positive",
        state === "starting" && "bg-caution",
        state === "crashed" && "bg-negative",
        (state === "stopped" || state === "none") && "ring-[1.5px] ring-faint ring-inset",
        state === "waiting" && "ring-[1.5px] ring-caution ring-inset",
        className
      )}
    >
      {state === "starting" ? <span className="absolute inset-0 animate-ping rounded-full bg-caution opacity-50 motion-reduce:hidden" /> : null}
    </span>
  )
}

function Log({ lines, dim, empty }: { lines: LogLine[]; dim?: boolean; empty?: string }) {
  if (!lines.length) return <p className="px-3 py-3 text-label text-faint">{empty ?? "Nothing written yet."}</p>
  return (
    <pre className={cn("min-h-0 flex-1 overflow-auto px-3 py-2.5 font-mono text-code leading-[18px] whitespace-pre-wrap", dim ? "text-faint" : "text-muted-foreground")}>
      {lines.map((line, index) => (
        <div key={index} className={line.error ? "-mx-3 border-l-2 border-negative bg-negative/10 px-[10px] text-foreground" : undefined}>
          {line.text || " "}
        </div>
      ))}
    </pre>
  )
}

function Header({ dot, title, detail, children }: { dot: AppState | AppProcessView["state"]; title: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-3 pt-2.5 pb-3">
      <div className="flex h-7 items-center gap-2.5">
        <StatusDot state={dot} />
        <p className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{title}</p>
        {children ? <div className="-mr-1 flex shrink-0 items-center gap-1">{children}</div> : null}
      </div>
      {detail ? <p className="pl-[18px] text-label text-faint">{detail}</p> : null}
    </div>
  )
}

function Address({ url, ready, on }: { url: string; ready: boolean; on: (action: AppAction) => void }) {
  const address = new URL(url)
  const [name, ...rest] = address.hostname.split(".")
  return (
    <div className="flex items-center gap-1.5 px-3 pb-3">
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-raised pr-1 pl-2.5 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
        <GlobeIcon className="size-3.5 shrink-0 text-faint" />
        <p className="flex min-w-0 flex-1 items-baseline text-ui tabular-nums" title={url}>
          <span className={cn("shrink-0", ready ? "text-foreground" : "text-muted-foreground")}>{name}</span>
          <span className="min-w-0 truncate text-faint">.{rest.join(".")}</span>
          <span className="shrink-0 text-muted-foreground">:{address.port}</span>
        </p>
        <IconAction label="Copy address" size="xs" onClick={() => on({ kind: "copy-url" })}><CopyIcon /></IconAction>
      </div>
      <Action tone="outline" size="md" disabled={!ready} onClick={() => on({ kind: "open" })}>
        Open<SquareArrowOutUpRightIcon className="size-3.5!" />
      </Action>
    </div>
  )
}

type Pane = { kind: "process"; name: string } | { kind: "checks" } | { kind: "install" }

function paneKey(pane: Pane): string {
  return pane.kind === "process" ? `process:${pane.name}` : pane.kind
}

function firstPane(view: AppView): Pane {
  if (view.state === "preparing" && view.prepare) return { kind: "install" }
  const crashed = view.processes.find((process) => process.state === "crashed")
  if (crashed) return { kind: "process", name: crashed.name }
  if (view.checks.some((check) => check.state === "failed")) return { kind: "checks" }
  const first = view.processes[0]
  return first ? { kind: "process", name: first.name } : view.prepare ? { kind: "install" } : { kind: "checks" }
}

function checksMark(checks: AppCheckView[]): ReactNode {
  if (checks.some((check) => check.state === "running")) return <LoaderCircleIcon className="size-3 animate-spin text-faint motion-reduce:animate-none" />
  if (checks.some((check) => check.state === "failed")) return <StatusDot state="crashed" className="size-1.5" />
  if (checks.some((check) => check.state === "passed")) return <CheckIcon className="size-3 text-positive" />
  return null
}

function PaneTabs({ view, pane, pick }: { view: AppView; pane: Pane; pick: (pane: Pane) => void }) {
  const tabs: { pane: Pane; label: ReactNode }[] = [
    ...(view.prepare ? [{ pane: { kind: "install" } as Pane, label: <>{view.state === "preparing" ? <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" /> : null}Install</> }] : []),
    ...view.processes.map((process) => ({
      pane: { kind: "process", name: process.name } as Pane,
      label: <><StatusDot state={process.state} className="size-1.5" />{process.name}{process.port ? <span className="font-normal text-faint tabular-nums">:{process.port}</span> : null}</>,
    })),
    ...(view.checks.length ? [{ pane: { kind: "checks" } as Pane, label: <>Checks{checksMark(view.checks)}</> }] : []),
  ]
  return (
    <div role="tablist" aria-label="Output" className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-y border-hairline bg-shell px-2">
      {tabs.map((tab) => {
        const active = paneKey(tab.pane) === paneKey(pane)
        return (
          <button
            key={paneKey(tab.pane)}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => pick(tab.pane)}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-label font-medium whitespace-nowrap transition-colors duration-100",
              active ? "bg-raised text-foreground" : "text-faint hover:bg-fill-hover hover:text-muted-foreground"
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

function Checks({ view, now, on }: { view: AppView; now: number; on: (action: AppAction) => void }) {
  const [open, setOpen] = useState<AppCheckView["tier"]>(view.checks.find((check) => check.state === "failed")?.tier ?? view.checks[0]?.tier ?? "quick")
  const shown = view.checks.find((check) => check.tier === open)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="divide-y divide-hairline border-b border-hairline">
        {view.checks.map((check) => {
          const result = check.state === "running" ? "Running…" : check.state === "never" ? "Not run in this Thread yet" : `${check.state === "passed" ? "Passed" : "Failed"} ${check.at ? ago(now - check.at) : ""}`
          return (
            <div key={check.tier} data-open={check.tier === open || undefined} className="group/check flex items-center gap-2.5 px-3 py-2 data-[open]:bg-fill-hover/60">
              <button type="button" onClick={() => setOpen(check.tier)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {check.state === "passed" ? <CheckIcon className="size-3.5 text-positive" />
                    : check.state === "failed" ? <XIcon className="size-3.5 text-negative" />
                    : check.state === "running" ? <LoaderCircleIcon className="size-3.5 animate-spin text-faint motion-reduce:animate-none" />
                    : <MinusIcon className="size-3.5 text-faint" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-ui font-medium text-foreground">{check.tier === "quick" ? "Quick check" : "Full check"}</span>
                    <span className={cn("truncate text-label", check.state === "failed" ? "text-negative" : "text-faint")}>{result}</span>
                  </span>
                  <span className="block truncate font-mono text-code text-faint">{check.command}</span>
                </span>
              </button>
              {check.state !== "running" ? (
                <Action tone="ghost" size="xs" className="text-label" onClick={() => on({ kind: "run-check", tier: check.tier })}><PlayIcon />Run</Action>
              ) : null}
            </div>
          )
        })}
      </div>
      {shown?.state === "failed" ? (
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <p className="min-w-0 flex-1 text-label text-muted-foreground">The {shown.tier} check failed. The agent can see this output.</p>
          <Action tone="outline" size="xs" className="text-label" onClick={() => on({ kind: "send-to-agent", what: `${shown.tier} check` })}>Send to agent</Action>
        </div>
      ) : null}
      <Log lines={shown?.output ?? []} empty="This check hasn't run in this Thread yet." />
    </div>
  )
}

function Footer({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  if (!view.recipe) return null
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-hairline px-3 text-label text-faint">
      <button type="button" onClick={() => on({ kind: "edit-recipe" })} className="min-w-0 truncate hover:text-muted-foreground">
        <span className="font-mono text-code">{view.recipe.file}</span>{view.recipe.overrides ? " + your overrides" : ""}
      </button>
      <span className="ml-auto shrink-0">Stops after {view.idleStopHours} h unused</span>
    </div>
  )
}

function Running({ view, now, on }: { view: AppView; now: number; on: (action: AppAction) => void }) {
  const [pane, setPane] = useState<Pane>(() => firstPane(view))
  const memory = bytes(view.processes.reduce((sum, process) => sum + (process.memoryBytes ?? 0), 0) || undefined)
  const crashed = view.processes.find((process) => process.state === "crashed")
  const selected = pane.kind === "process" ? view.processes.find((process) => process.name === pane.name) : undefined
  const count = view.processes.length > 1 ? `${view.processes.length} processes` : ""
  const header =
    view.state === "running" ? (
      <Header dot="running" title="Running" detail={[view.startedAt ? `Started ${ago(now - view.startedAt)}` : "", count, memory].filter(Boolean).join(" · ")}>
        <Action tone="ghost" size="sm" onClick={() => on({ kind: "restart" })}><RotateCwIcon />Restart</Action>
        <Action tone="ghost" size="sm" onClick={() => on({ kind: "stop" })}><SquareIcon />Stop</Action>
      </Header>
    ) : view.state === "starting" ? (
      <Header dot="starting" title="Starting" detail="Waiting for the app to answer on its port">
        <Action tone="ghost" size="sm" onClick={() => on({ kind: "stop" })}><SquareIcon />Stop</Action>
      </Header>
    ) : view.state === "preparing" && view.prepare ? (
      <Header dot="starting" title="Installing" detail={`${view.prepare.command} · ${view.prepare.reason}`}>
        <Action tone="ghost" size="sm" onClick={() => on({ kind: "stop" })}><SquareIcon />Stop</Action>
      </Header>
    ) : view.state === "crashed" && crashed ? (
      <Header
        dot="crashed"
        title={`${crashed.name} crashed`}
        detail={crashed.exit ? `Exited${crashed.exit.code !== null ? ` with code ${crashed.exit.code}` : ""} after ${duration(crashed.exit.afterMs)}, ${ago(now - crashed.exit.at)}` : undefined}
      >
        <Action tone="outline" size="sm" onClick={() => on({ kind: "send-to-agent", what: crashed.name })}>Send to agent</Action>
        <Action tone="solid" size="sm" onClick={() => on({ kind: "restart" })}><RotateCwIcon />Restart</Action>
      </Header>
    ) : (
      <Header dot="stopped" title="Stopped" detail={view.startedAt ? `Last ran ${ago(now - view.startedAt)}` : `Starts on this Thread's own port`}>
        <Action tone="solid" size="sm" onClick={() => on({ kind: "start" })}><PlayIcon className="fill-current" />Start</Action>
      </Header>
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {view.url ? <Address url={view.url} ready={view.state === "running"} on={on} /> : null}
      <PaneTabs view={view} pane={pane} pick={setPane} />
      {pane.kind === "checks" ? <Checks view={view} now={now} on={on} />
        : pane.kind === "install" ? <Log lines={view.prepare?.log ?? []} />
        : <Log lines={selected?.log ?? []} dim={view.state === "stopped"} />}
      <Footer view={view} on={on} />
    </div>
  )
}

function Waiting({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header dot="waiting" title="Waiting for memory" detail="Your Mac is short on memory, so this app hasn't started">
        <Action tone="ghost" size="sm" onClick={() => on({ kind: "retry" })}><RotateCwIcon />Try again</Action>
      </Header>
      <div className="px-3 pb-3">
        <p className="mb-2 text-label text-muted-foreground">Stopping another Thread's app frees room now. Its files and data stay.</p>
        <ListCard className="px-0">
          {view.room?.map((other) => (
            <div key={other.thread} className="flex items-center gap-2.5 px-3 py-2.5">
              <StatusDot state="running" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui text-foreground">{other.thread}</p>
                <p className="truncate text-label text-faint">{bytes(other.memoryBytes)} · {unused(other.quietMs)}</p>
              </div>
              <Action tone="outline" size="sm" onClick={() => on({ kind: "stop-other", thread: other.thread })}>Stop</Action>
            </div>
          ))}
        </ListCard>
      </div>
      <div className="mt-auto"><Footer view={view} on={on} /></div>
    </div>
  )
}

function NotSetUp({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto px-5 pt-10 pb-6">
      <div className="mb-4 flex size-9 items-center justify-center rounded-lg bg-raised text-muted-foreground [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
        <AppWindowIcon className="size-4" />
      </div>
      <h2 className="text-title font-medium text-foreground">Run {view.project} in this Thread</h2>
      <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
        Each Thread can run its own copy of the app, on its own port and with its own data, so you can open what that Thread changed while others run beside it.
      </p>
      {view.found?.length ? (
        <div className="mt-5">
          <p className="mb-1.5 text-label font-medium text-faint">What {view.project} already says about running it</p>
          <ListCard className="px-0">
            {view.found.map((entry) => (
              <div key={entry.command} className="flex items-baseline gap-3 px-3 py-2">
                <span className="shrink-0 font-mono text-code text-foreground">{entry.command}</span>
                <span className="min-w-0 truncate text-label text-faint">{entry.says}</span>
              </div>
            ))}
          </ListCard>
        </div>
      ) : null}
      <div className="mt-5 flex flex-col gap-2">
        <Action tone="solid" size="md" className="w-full" onClick={() => on({ kind: "setup" })}>Set up with {view.setupWith?.harness ?? "an agent"}</Action>
        {view.setupWith ? (
          <p className="text-center text-label text-faint">
            {view.setupWith.model} ·{" "}
            <button type="button" className="text-muted-foreground underline decoration-hairline underline-offset-2 hover:text-foreground" onClick={() => on({ kind: "setup-model" })}>change</button>
          </p>
        ) : null}
      </div>
      <p className="mt-5 text-label leading-relaxed text-faint">
        Setup runs in a Thread of its own, on a new branch. It works out how {view.project} starts, writes <span className="font-mono text-code">.mako/environment.json</span>, and starts the app to prove it. Nothing here changes until you merge it.
      </p>
      <button type="button" onClick={() => on({ kind: "write-recipe" })} className="mt-auto pt-6 text-left text-label text-faint hover:text-muted-foreground">
        Or write <span className="font-mono text-code">.mako/environment.json</span> yourself
      </button>
    </div>
  )
}

function SettingUp({ view, on }: { view: AppView; on: (action: AppAction) => void }) {
  const setup = view.setup
  if (!setup) return null
  const done = setup.steps.filter((step) => step.state === "done").length
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header dot="starting" title="Being set up" detail={`In “${setup.thread}” · ${setup.harness}, ${setup.model}`}>
        <Action tone="outline" size="sm" onClick={() => on({ kind: "open-setup" })}>Open Thread</Action>
      </Header>
      <div className="px-3 pb-3">
        <div className="mb-3 h-1 overflow-hidden rounded-full bg-raised">
          <div className="h-full rounded-full bg-foreground/45 transition-[width] duration-500" style={{ width: `${(done / setup.steps.length) * 100}%` }} />
        </div>
        <ol className="flex flex-col">
          {setup.steps.map((step) => (
            <li key={step.label} className="flex h-8 items-center gap-2.5 text-ui">
              <span className="flex size-4 shrink-0 items-center justify-center">
                {step.state === "done" ? <CheckIcon className="size-3.5 text-positive" />
                  : step.state === "doing" ? <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
                  : <span className="size-1.5 rounded-full bg-faint/50" />}
              </span>
              <span className={step.state === "todo" ? "text-faint" : "text-foreground"}>{step.label}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-auto border-t border-hairline px-3 py-2.5 text-label text-faint">
        Every Thread of {view.project} gets the app once this is merged.
      </p>
    </div>
  )
}

/** The App tab of the right sidebar: this Thread's own copy of the project's app. */
export function AppPanelView({ view, now, on }: { view: AppView; now: number; on: (action: AppAction) => void }) {
  switch (view.state) {
    case "none": return <NotSetUp view={view} on={on} />
    case "setting-up": return <SettingUp view={view} on={on} />
    case "waiting": return <Waiting view={view} on={on} />
    default: return <Running view={view} now={now} on={on} />
  }
}
