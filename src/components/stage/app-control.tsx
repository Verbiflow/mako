import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import {
  AppWindowIcon,
  CheckIcon,
  HourglassIcon,
  CopyIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SquareArrowOutUpRightIcon,
  SquareIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react"
import { ENVIRONMENT_SETUP_PROMPT } from "../../../electron/contracts/thread-environments"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import { desktop } from "@/state/desktop"
import { actions } from "@/state/session"
import {
  checkMark,
  checkTitle,
  formatAgo,
  formatBytes,
  formatDuration,
  hideSetupFor,
  processKey,
  processMark,
  sendToAgent,
  showAppOutput,
  threadAppDriver,
  useThreadApp,
  type AppCheckView,
  type AppProcessView,
  type Mark,
  type ThreadAppView,
} from "@/state/thread-app"

type Ready = Extract<ThreadAppView, { kind: "ready" }>

const trigger =
  "pressable flex h-6 shrink-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-label whitespace-nowrap " +
  "[transition:transform_var(--duration-press)_var(--ease-out),width_220ms_var(--ease-out),background-color_120ms_ease,color_120ms_ease] " +
  "hover:bg-fill-hover data-[state=open]:bg-fill-hover"

/**
 * Done, failed, working or not yet: the one mark every row of the app uses.
 * A mark that changes arrives rather than swapping in place.
 */
export function AppMark({ mark, className }: { mark: Mark; className?: string }) {
  const [first] = useState(mark)
  const props = {
    "data-changed": first === mark ? undefined : "",
    className: cn("app-mark flex size-3.5 shrink-0 items-center justify-center", className),
  }
  if (mark === "done" || mark === "live")
    return <CheckIcon key={mark} {...props} aria-label={mark === "live" ? "Running" : "Passed"} className={cn(props.className, "text-positive")} strokeWidth={2.5} />
  if (mark === "failed") return <XIcon key={mark} {...props} aria-label="Failed" className={cn(props.className, "text-negative")} strokeWidth={2.5} />
  if (mark === "running")
    return <LoaderCircleIcon key={mark} {...props} aria-label="Working" className={cn(props.className, "animate-spin text-muted-foreground")} strokeWidth={2.25} />
  return (
    <span key={mark} {...props} aria-label="Not yet">
      <span className="size-2.5 rounded-full border-[1.5px] border-faint/55" />
    </span>
  )
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * The Thread's own copy of its app, at the right of the strip beside the
 * checkout. It names one state; its menu says what's running and what was
 * checked, and each row opens that output in the terminal dock.
 */
export function AppControl({ cwd }: { cwd: string | undefined }) {
  const view = useThreadApp((state) => (cwd ? state.byCwd[cwd] : undefined))
  const hidden = useThreadApp((state) => view?.kind === "none" && state.hidden.includes(view.root))
  if (!cwd || !view || hidden) return null
  const state = view.kind === "ready" ? view.phase : view.kind
  if (view.kind === "ready" && view.phase === "stopped") {
    return (
      <button
        type="button"
        data-app-control="stopped"
        className={cn(trigger, "mr-0.5 text-faint hover:text-foreground")}
        onClick={() => threadAppDriver()?.start(cwd)}
      >
        <PlayIcon className="size-3 shrink-0 fill-current" />
        <span key={state} className="changing-label">Run app</span>
      </button>
    )
  }
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button type="button" data-app-control={state} className={cn(trigger, "mr-0.5", triggerTone(view))}>
          <TriggerLabel view={view} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-80" onCloseAutoFocus={(event) => event.preventDefault()}>
        {view.kind === "none" ? (
          <NoneMenu view={view} />
        ) : view.kind === "setting-up" ? (
          <SettingUpMenu cwd={cwd} view={view} />
        ) : (
          <ReadyMenu cwd={cwd} view={view} />
        )}
      </MenuContent>
    </Menu>
  )
}

function triggerTone(view: ThreadAppView): string {
  if (view.kind === "ready" && view.phase === "crashed") return "text-negative"
  if (view.kind === "ready" && view.phase === "waiting") return "text-caution"
  if (view.kind === "ready" && view.phase === "running") return "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
  return "text-faint hover:text-muted-foreground data-[state=open]:text-foreground"
}

function TriggerLabel({ view }: { view: ThreadAppView }) {
  const [icon, label] = triggerParts(view)
  return (
    <>
      {icon}
      <span key={label} className="changing-label">{label}</span>
    </>
  )
}

function triggerParts(view: ThreadAppView): [ReactNode, string] {
  const icon = "size-3.5 shrink-0"
  const working = <LoaderCircleIcon key="icon" className={cn(icon, "animate-spin")} />
  if (view.kind === "none") return [<PlayIcon key="icon" className="size-3 shrink-0 fill-current" />, "Run app"]
  if (view.kind === "setting-up") return [working, "Setting up"]
  switch (view.phase) {
    case "preparing":
      return [working, "Installing"]
    case "starting":
      return [working, "Starting"]
    case "running":
      return [<AppWindowIcon key="icon" className={icon} />, "App running"]
    case "crashed":
      return [<XIcon key="icon" className={icon} strokeWidth={2.5} />, "App crashed"]
    case "waiting":
      return [<HourglassIcon key="icon" className={icon} />, "Waiting for memory"]
    default:
      return [null, ""]
  }
}

function address(view: Ready): string {
  return `http://${view.host}:${view.port}/`
}

function copyAddress(view: Ready): void {
  void navigator.clipboard.writeText(address(view)).then(
    () => toast("Address copied"),
    () => toast.error("The address wasn't copied")
  )
}

/** The top of every menu: what state the app is in, and at most one sentence about it. */
function Head({ title, aside, children }: { title: string; aside?: string; children?: ReactNode }) {
  return (
    <div className="px-2 pt-2 pb-2.5">
      <div className="flex h-5 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        {aside ? <span className="shrink-0 text-label text-faint tabular-nums">{aside}</span> : null}
      </div>
      {children ? <p className="mt-1 text-label text-muted-foreground">{children}</p> : null}
    </div>
  )
}

function Action({ icon, children, className, ...props }: { icon: ReactNode; children: ReactNode } & Omit<Parameters<typeof MenuItem>[0], "children">) {
  return (
    <MenuItem className={cn("[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground", className)} {...props}>
      {icon}
      {children}
    </MenuItem>
  )
}

function NoneMenu({ view }: { view: Extract<ThreadAppView, { kind: "none" }> }) {
  return (
    <>
      <Head title="Not set up">Mako doesn't know how to run {view.project} yet.</Head>
      <Action data-app-action="set-up" icon={<PlusIcon />} onSelect={() => void setUp(view.root)}>
        Set up in a new Thread
      </Action>
      <MenuSeparator />
      <Action className="text-muted-foreground" icon={<EyeOffIcon />} onSelect={() => hideSetupFor(view.root)}>
        Don't offer this for {view.project}
      </Action>
    </>
  )
}

/** A new Thread in the project with the setup prompt written; the person picks the agent and sends it. */
async function setUp(root: string): Promise<void> {
  if (!(await actions.newConversationIn(root))) return
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("mako:compose", { detail: { text: ENVIRONMENT_SETUP_PROMPT } }))
  )
}

function SettingUpMenu({ cwd, view }: { cwd: string; view: Extract<ThreadAppView, { kind: "setting-up" }> }) {
  return (
    <>
      <Head title="Setting up">
        Every Thread of {view.project} gets the app once “{view.thread.title}” is merged.
      </Head>
      <MenuSeparator />
      <div className="py-0.5">
        {view.steps.map((step) => (
          <div key={step.label} className={cn("flex h-8 items-center gap-2 px-2", step.state === "waiting" ? "text-faint" : "text-foreground")}>
            <AppMark mark={step.state === "done" ? "done" : step.state} />
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
          </div>
        ))}
      </div>
      <MenuSeparator />
      <Action icon={<HarnessIcon harness={view.thread.harness} className="size-3.5" />} onSelect={() => threadAppDriver()?.openSetupThread(cwd)}>
        Open “{view.thread.title}”
      </Action>
    </>
  )
}

function ReadyMenu({ cwd, view }: { cwd: string; view: Ready }) {
  const now = useNow()
  const driver = threadAppDriver()
  const crashed = view.processes.find((process) => process.exit && process.exit.code !== 0)
  return (
    <>
      <ReadyHead view={view} crashed={crashed} now={now} />
      {view.phase === "running" ? (
        <MenuItem
          data-app-action="copy-address"
          title="Copy the address"
          className="group mb-1 min-h-7 bg-raised/70 text-label tabular-nums data-[highlighted]:bg-fill-selected"
          onSelect={() => copyAddress(view)}
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="text-foreground">{view.host.split(".")[0]}</span>
            <span className="text-faint">.{view.host.split(".").slice(1).join(".")}:{view.port}</span>
          </span>
          <CopyIcon className="size-3 shrink-0 text-faint transition-colors group-data-[highlighted]:text-foreground" />
        </MenuItem>
      ) : null}
      {view.phase === "waiting" ? null : <Rows cwd={cwd} view={view} now={now} />}
      <MenuSeparator />
      {view.phase === "running" ? (
        <>
          <Action data-app-action="open" icon={<SquareArrowOutUpRightIcon />} onSelect={() => void desktop.openUrl(address(view))}>
            Open in browser
          </Action>
          <Action data-app-action="restart" icon={<RotateCwIcon />} onSelect={() => driver?.restart(cwd)}>
            Restart
          </Action>
          <Action data-app-action="stop" icon={<SquareIcon />} onSelect={() => driver?.stop(cwd)}>
            Stop
          </Action>
        </>
      ) : view.phase === "crashed" && crashed ? (
        <>
          <Action data-app-action="send-to-agent" icon={<MessageSquareTextIcon />} onSelect={() => sendToAgent(cwd, { process: crashed })}>
            Ask the agent to fix it
          </Action>
          <Action data-app-action="show-output" icon={<TerminalSquareIcon />} onSelect={() => showAppOutput(cwd, processKey(crashed.name))}>
            Show what it printed
          </Action>
          <Action data-app-action="restart" icon={<RotateCwIcon />} onSelect={() => driver?.restart(cwd)}>
            Restart
          </Action>
        </>
      ) : view.phase === "waiting" && view.room ? (
        <>
          <Action data-app-action="make-room" icon={<SquareIcon />} onSelect={() => driver?.makeRoom(cwd)}>
            Stop the other {view.room.apps === 1 ? "app" : `${view.room.apps} apps`} and start this one
          </Action>
          <Action data-app-action="retry" icon={<RotateCwIcon />} onSelect={() => driver?.start(cwd)}>
            Try again
          </Action>
        </>
      ) : (
        <Action data-app-action="stop" icon={<SquareIcon />} onSelect={() => driver?.stop(cwd)}>
          Stop
        </Action>
      )}
    </>
  )
}

function ReadyHead({ view, crashed, now }: { view: Ready; crashed?: AppProcessView; now: number }) {
  switch (view.phase) {
    case "running":
      return <Head title="Running" aside={`started ${formatAgo(view.startedAt ?? now, now)}`} />
    case "crashed":
      return (
        <Head title="Crashed">
          {crashed?.exit
            ? `${crashed.name} stopped with code ${crashed.exit.code}, ${formatDuration(crashed.exit.afterMs)} after it started.`
            : "A process stopped."}
        </Head>
      )
    case "waiting":
      return (
        <Head title="Waiting for memory">
          {view.room
            ? `Your Mac is short on memory. ${view.room.apps === 1 ? "Another Thread's app is" : `${view.room.apps} other Threads' apps are`} using ${formatBytes(view.room.bytes)}.`
            : "Your Mac is short on memory."}
        </Head>
      )
    case "preparing":
      return <Head title="Installing">{view.prepare ? `Because ${view.prepare.reason}.` : undefined}</Head>
    default:
      return <Head title="Starting" />
  }
}

/** What's running and what was checked; each row opens its output in the terminal dock. */
function Rows({ cwd, view, now }: { cwd: string; view: Ready; now: number }) {
  return (
    <>
      <MenuSeparator />
      {view.phase === "preparing" && view.prepare ? (
        <Row mark="running" title="Install" detail={view.prepare.command} onSelect={() => showAppOutput(cwd, "prepare")} />
      ) : null}
      {view.processes.map((process) => (
        <ProcessRow key={process.name} process={process} onSelect={() => showAppOutput(cwd, processKey(process.name))} />
      ))}
      {view.checks.map((check) => (
        <CheckRow
          key={check.tier}
          check={check}
          now={now}
          onSelect={() => {
            if (check.state === "never") threadAppDriver()?.runCheck(cwd, check.tier)
            showAppOutput(cwd, `check:${check.tier}`)
          }}
        />
      ))}
    </>
  )
}

function Row({ mark, title, detail, hint, onSelect }: { mark: Mark; title: string; detail?: ReactNode; hint?: ReactNode; onSelect: () => void }) {
  return (
    <MenuItem onSelect={onSelect} data-app-row={title} className="group">
      <AppMark mark={mark} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="grid shrink-0 justify-items-end text-label text-faint tabular-nums">
        <span className={cn("col-start-1 row-start-1 transition-opacity duration-100", hint && "group-data-[highlighted]:opacity-0")}>{detail}</span>
        {hint ? (
          <span className="col-start-1 row-start-1 flex items-center gap-1 text-foreground opacity-0 transition-opacity duration-100 group-data-[highlighted]:opacity-100">
            {hint}
          </span>
        ) : null}
      </span>
    </MenuItem>
  )
}

function ProcessRow({ process, onSelect }: { process: AppProcessView; onSelect: () => void }) {
  const detail =
    process.exit && process.exit.code !== 0
      ? `Exited with ${process.exit.code}`
      : process.state === "starting"
        ? "Starting"
        : process.memoryBytes
          ? formatBytes(process.memoryBytes)
          : undefined
  return <Row mark={processMark(process)} title={process.name} detail={detail} hint="Show output" onSelect={onSelect} />
}

function CheckRow({ check, now, onSelect }: { check: AppCheckView; now: number; onSelect: () => void }) {
  const detail =
    check.state === "never"
      ? "Not run"
      : check.state === "running"
        ? "Running"
        : check.at
          ? formatAgo(check.at, now)
          : undefined
  const hint =
    check.state === "never" ? (
      <>
        <PlayIcon className="size-2.5 fill-current" />
        Run
      </>
    ) : (
      "Show output"
    )
  return <Row mark={checkMark(check)} title={checkTitle(check.tier)} detail={detail} hint={hint} onSelect={onSelect} />
}
