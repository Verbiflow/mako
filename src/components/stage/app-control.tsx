import { useHarnessIdentity } from "@/lib/harness-label"
import { Fragment, useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { CheckIcon, ChevronDownIcon, HourglassIcon, LoaderCircleIcon, PlayIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import type { SetupStep } from "../../../electron/contracts/thread-app"
import { environmentRepairPrompt } from "../../../electron/contracts/thread-environments"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu"
import { Shimmer } from "@/components/ui/shimmer"
import { AppProbeMenu } from "@/components/stage/app-probe"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { openAppSetup } from "@/state/app-setup"
import { desktop } from "@/state/desktop"
import {
  setUpInThisThread,
  setupAgentLabel,
  startProjectSetup,
  useSetupAgent,
  useThreadAgent,
  type SetupAgent,
} from "@/state/project-setup"
import { actions } from "@/state/session"
import {
  checkMark,
  checkTitle,
  copyAppFailure,
  formatAgo,
  formatBytes,
  formatDuration,
  hideSetupFor,
  pickTarget,
  processKey,
  processMark,
  sendToAgent,
  showAppOutput,
  showSetupFor,
  stepKey,
  stepMark,
  targetOf,
  threadAppDriver,
  useThreadApp,
  type AppCheckStepView,
  type AppCheckView,
  type AppFailure,
  type AppProcessView,
  type Mark,
  type ThreadAppView,
} from "@/state/thread-app"

type Ready = Extract<ThreadAppView, { kind: "ready" }>

const trigger =
  "pressable flex h-6 shrink-0 items-center overflow-hidden rounded-md px-2 text-label font-medium whitespace-nowrap " +
  "[transition:transform_var(--duration-press)_var(--ease-out),width_220ms_var(--ease-out),background-color_120ms_ease,color_120ms_ease] " +
  "hover:bg-fill-hover data-[state=open]:bg-fill-hover"

/**
 * Done, failed, working or not yet: the one mark every row of the app uses.
 * A mark that changes arrives rather than swapping in place.
 */
function AppMark({ mark, className }: { mark: Mark; className?: string }) {
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
export function AppControl({ cwd, focused }: { cwd: string | undefined; focused: boolean }) {
  const view = useThreadApp((state) => (cwd ? state.byCwd[cwd] : undefined))
  const hidden = useThreadApp((state) => view?.kind === "none" && state.hidden.includes(view.root))
  const target = useThreadApp((state) => (cwd ? targetOf(state, cwd) : undefined))
  useEffect(() => (cwd ? threadAppDriver()?.watch?.(cwd) : undefined), [cwd])
  if (!cwd || !view || hidden) return null
  const state = view.kind === "ready" ? view.phase : view.kind
  const project = view.kind === "ready" ? cwd : view.root
  if (view.kind === "ready" && view.phase === "stopped" && view.elsewhere) {
    return (
      <Menu modal={false}>
        <WithSetup project={project}>
          <MenuTrigger asChild>
            <button type="button" data-app-control="stopped" className={cn(trigger, "mr-0.5", triggerTone(view))}>
              <TriggerLabel view={view} />
            </button>
          </MenuTrigger>
        </WithSetup>
        <MenuContent align="end" className="w-80" onCloseAutoFocus={(event) => event.preventDefault()}>
          <Head title="Run it here instead?">{`Only one copy of ${view.project}'s app runs at a time, and ${view.elsewhere} has it.`}</Head>
          <MenuSeparator />
          <Action data-app-action="take-turn" onSelect={() => threadAppDriver()?.takeTurn(cwd)}>
            Stop it there and run it here
          </Action>
          <SetupItem project={project} />
        </MenuContent>
      </Menu>
    )
  }
  if (view.kind === "ready" && view.phase === "stopped") {
    const run = () => threadAppDriver()?.start(cwd)
    const shown = picking(view) ? target : undefined
    const button = (
      <button type="button" data-app-control="stopped" className={cn(trigger, shown ? "rounded-r-none pr-1.5" : "mr-0.5", triggerTone(view))} onClick={run}>
        <TriggerLabel view={view} target={shown} />
      </button>
    )
    return (
      <WithSetup project={project} run={run} runLabel={shown ? `Run ${shown}` : undefined}>
        {shown ? (
          <span className="mr-0.5 flex shrink-0 items-center">
            {button}
            <TargetPicker cwd={cwd} targets={view.targets!} target={shown} />
          </span>
        ) : (
          button
        )}
      </WithSetup>
    )
  }
  return (
    <Menu modal={false}>
      <WithSetup project={project}>
        <MenuTrigger asChild>
          <button type="button" data-app-control={state} className={cn(trigger, "mr-0.5", triggerTone(view))}>
            <TriggerLabel view={view} />
          </button>
        </MenuTrigger>
      </WithSetup>
      <MenuContent align="end" className="w-80" onCloseAutoFocus={(event) => event.preventDefault()}>
        {view.kind === "none" ? (
          <NoneMenu cwd={cwd} view={view} focused={focused} />
        ) : view.kind === "invalid" ? (
          <InvalidMenu view={view} />
        ) : view.kind === "setting-up" ? (
          <SettingUpMenu view={view} />
        ) : (
          <ReadyMenu cwd={cwd} view={view} target={target} />
        )}
        {view.kind === "ready" || view.kind === "invalid" ? <SetupItem project={project} /> : null}
      </MenuContent>
    </Menu>
  )
}

/**
 * Right-click on the control, in any state: the project's app in Settings,
 * and Run when a click would run it.
 */
function WithSetup({ project, run, runLabel = "Run app", children }: { project: string; run?: () => void; runLabel?: string; children: ReactNode }) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <span className="contents">{children}</span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {run ? (
          <>
            <MenuItem data-app-action="run" onSelect={run}>{runLabel}</MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <SetupRowItem project={project} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The last row of the control's own menu: the project's app in Settings. */
function SetupItem({ project }: { project: string }) {
  return (
    <>
      <MenuSeparator />
      <SetupRowItem project={project} />
    </>
  )
}

function SetupRowItem({ project }: { project: string }) {
  return (
    <MenuItem data-app-action="app-setup" onSelect={() => openAppSetup(project)}>
      App setup
    </MenuItem>
  )
}

function triggerTone(view: ThreadAppView): string {
  if (view.kind === "invalid" || (view.kind === "ready" && view.phase === "crashed")) return "text-negative"
  if (view.kind === "ready" && view.phase === "waiting") return "text-caution"
  return "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
}

function TriggerLabel({ view, target }: { view: ThreadAppView; target?: string }) {
  const [label, working] = triggerParts(view, target)
  return (
    <span key={label} className="changing-label">
      <span className="flex items-center gap-1.5">
        <TriggerIcon view={view} />
        {working ? <Shimmer text={label} /> : label}
      </span>
    </span>
  )
}

/** What the control would do or is doing: run, working, running, waiting or failed. */
function TriggerIcon({ view }: { view: ThreadAppView }) {
  const icon = "size-3 shrink-0"
  switch (view.kind === "ready" ? view.phase : view.kind) {
    case "setting-up":
    case "preparing":
    case "starting":
      return <LoaderCircleIcon aria-hidden className={cn(icon, "animate-spin")} strokeWidth={2.5} />
    case "running":
      return <PlayIcon aria-hidden className={cn(icon, "fill-current text-positive")} strokeWidth={2.5} />
    case "invalid":
    case "crashed":
      return <TriangleAlertIcon aria-hidden className={icon} strokeWidth={2.25} />
    case "waiting":
      return <HourglassIcon aria-hidden className={icon} strokeWidth={2.25} />
    default:
      return <PlayIcon aria-hidden className={cn(icon, "fill-current")} strokeWidth={2.5} />
  }
}

/** The words on the control, and whether they name work still under way. */
function triggerParts(view: ThreadAppView, target?: string): [string, boolean] {
  if (view.kind === "none") return ["Run app", false]
  if (view.kind === "invalid") return ["Can't run app", false]
  if (view.kind === "setting-up") return ["Setting up", true]
  switch (view.phase) {
    case "stopped":
      return [target ? `Run ${target}` : "Run app", false]
    case "preparing":
      return ["Installing", true]
    case "starting":
      return ["Starting", true]
    case "running":
      return ["App running", false]
    case "crashed":
      return [view.prepare?.exit ? "Install failed" : "App crashed", false]
    case "waiting":
      return ["Waiting for memory", false]
    default:
      return ["", false]
  }
}

function address({ host, port }: { host: string; port: number }): string {
  return `http://${host}:${port}/`
}

function copyAddress(at: { host: string; port: number }): void {
  void navigator.clipboard.writeText(address(at)).then(
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

function Action({ children, ...props }: { children: ReactNode } & Omit<Parameters<typeof MenuItem>[0], "children">) {
  return <MenuItem {...props}>{children}</MenuItem>
}

/**
 * Two ways to set a project up: the Thread on screen asks its own agent, on
 * whatever model it's on; a new Thread does it in a worktree of its own.
 */
function NoneMenu({ cwd, view, focused }: { cwd: string; view: Extract<ThreadAppView, { kind: "none" }>; focused: boolean }) {
  useHarnessIdentity()
  const fresh = useSetupAgent()
  const here = useThreadAgent()
  const stopped = view.stopped
  const hide = () => {
    hideSetupFor(view.root)
    toast(`Run app is hidden for ${view.project}`, { duration: ACTION_TOAST_MS, action: { label: "Undo", onClick: () => showSetupFor(view.root) } })
  }
  return (
    <>
      <Head title={`${view.project} isn't set up to run yet`}>
        An agent works out how it installs, starts and gets checked. That's done once; then every Thread can run its own copy.
        {fresh?.standingInFor ? ` ${harnessLabel(fresh.standingInFor)} isn't signed in, so ${harnessLabel(fresh.harness)} stands in for it.` : null}
        {fresh ? null : " Sign in to an agent in Settings first."}
      </Head>
      {stopped ? (
        <Action data-app-action="open-stopped-setup" onSelect={() => void openConversation(stopped.conversation)}>
          <span className="min-w-0 truncate">Continue in “{stopped.title}”</span>
        </Action>
      ) : null}
      {focused && here ? (
        <SetupChoice action="set-up-here" agent={here} onSelect={() => void setUpInThisThread(cwd, view.project)}>
          Set up in this Thread
        </SetupChoice>
      ) : null}
      {fresh ? (
        <SetupChoice action="set-up" agent={fresh} onSelect={() => void startProjectSetup(view.root, view.project)}>
          Set up in a new Thread
        </SetupChoice>
      ) : null}
      <MenuSeparator />
      <Action data-app-action="hide" className="text-muted-foreground" onSelect={hide}>
        {view.project} has no app to run
      </Action>
    </>
  )
}

function SetupChoice({ action, agent, onSelect, children }: { action: string; agent: SetupAgent; onSelect: () => void; children: ReactNode }) {
  return (
    <MenuItem data-app-action={action} className="group gap-3" onSelect={onSelect}>
      <span className="shrink-0 whitespace-nowrap">{children}</span>
      <span className="min-w-0 flex-1 truncate text-right text-label text-faint transition-colors duration-100 group-data-[highlighted]:text-muted-foreground">
        {setupAgentLabel(agent)}
      </span>
    </MenuItem>
  )
}

/** A new Thread in the project with the request written; the person picks the agent and sends it. */
async function newThreadWith(root: string, text: string): Promise<void> {
  if (!(await actions.newConversationIn(root))) return
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:compose", { detail: { text } })))
}

function InvalidMenu({ view }: { view: Extract<ThreadAppView, { kind: "invalid" }> }) {
  return (
    <>
      <Head title="Can't run the app">
        <span className="line-clamp-4">Mako's recipe for {view.project} is broken: {view.message}</span>
      </Head>
      <MenuSeparator />
      <Action data-app-action="repair" onSelect={() => void newThreadWith(view.root, environmentRepairPrompt(view.message))}>
        Fix it in a new Thread
      </Action>
      <Action data-app-action="copy-problem" onSelect={() => void actions.copy(environmentRepairPrompt(view.message))}>
        Copy to paste elsewhere
      </Action>
    </>
  )
}

function SettingUpMenu({ view }: { view: Extract<ThreadAppView, { kind: "setting-up" }> }) {
  return (
    <>
      <Head title="Setting up">
        “{view.thread.title}” is working out how to run {view.project}. Every Thread of it gets the app once that's saved.
      </Head>
      {view.progress ? (
        <>
          <MenuSeparator />
          <SetupRow step={view.progress.recipe}>Recipe saved</SetupRow>
          <SetupRow step={view.progress.app}>App started</SetupRow>
          <SetupRow step={view.progress.checks}>Checks passed</SetupRow>
        </>
      ) : null}
      <MenuSeparator />
      <Action data-app-action="open-setup" onSelect={() => void openConversation(view.thread.conversation)}>
        Open “{view.thread.title}”
      </Action>
    </>
  )
}

/** One step of the setup: shown, not clicked; the Thread itself is one action below. */
function SetupRow({ step, children }: { step: SetupStep; children: ReactNode }) {
  return (
    <div data-setup-step={step} className="flex min-h-8 items-center gap-2 px-2">
      <AppMark mark={step} />
      <span className={cn("min-w-0 flex-1 truncate transition-colors duration-200", step === "waiting" ? "text-faint" : "text-foreground")}>
        {children}
      </span>
    </div>
  )
}

async function openConversation(id: string): Promise<void> {
  const { acp } = await import("@/state/acp")
  if (!acp.activate(id)) toast("That Thread isn't open in this window")
}

function ReadyMenu({ cwd, view, target }: { cwd: string; view: Ready; target: string | undefined }) {
  const now = useNow()
  const driver = threadAppDriver()
  const crashed = view.processes.find((process) => process.exit && process.exit.code !== 0)
  const failure: AppFailure | undefined = crashed ? { process: crashed } : view.prepare?.exit ? { prepare: view.prepare } : undefined
  const at = view.address
  return (
    <>
      <ReadyHead view={view} crashed={crashed} now={now} />
      {view.phase === "running" && at ? (
        <MenuItem
          data-app-action="copy-address"
          title="Copy the address"
          className="group mb-1 min-h-7 bg-raised/70 text-label tabular-nums data-[highlighted]:bg-fill-selected"
          onSelect={() => copyAddress(at)}
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="text-foreground">{at.host.split(".")[0]}</span>
            <span className="text-faint">.{at.host.split(".").slice(1).join(".")}:{at.port}</span>
          </span>
          <span className="shrink-0 text-faint transition-colors group-data-[highlighted]:text-foreground">Copy</span>
        </MenuItem>
      ) : null}
      {view.phase === "waiting" ? null : <Rows cwd={cwd} view={view} now={now} />}
      {view.phase === "waiting" || !driver?.probe ? null : <AppProbeMenu cwd={cwd} now={now} />}
      <MenuSeparator />
      {view.phase === "running" ? (
        <>
          {at ? (
            <Action data-app-action="open" onSelect={() => void desktop.openUrl(address(at))}>
              Open in browser
            </Action>
          ) : null}
          <Action data-app-action="restart" onSelect={() => driver?.restart(cwd)}>
            Restart
          </Action>
          {picking(view) && target ? (
            <MenuSub>
              <MenuSubTrigger data-app-action="restart-as">
                <span className="min-w-0 flex-1 truncate">Restart as</span>
                <span className="shrink-0 text-label text-faint">{target}</span>
              </MenuSubTrigger>
              <MenuSubContent className="w-48">
                <TargetChoices targets={view.targets!} target={target} onPick={(next) => { pickTarget(cwd, next); driver?.restart(cwd) }} />
              </MenuSubContent>
            </MenuSub>
          ) : null}
          <Action data-app-action="stop" onSelect={() => driver?.stop(cwd)}>
            Stop
          </Action>
        </>
      ) : view.phase === "crashed" && failure ? (
        <>
          <Action data-app-action="send-to-agent" onSelect={() => void sendToAgent(cwd, failure)}>
            Ask the agent to fix it
          </Action>
          <Action data-app-action="copy-failure" onSelect={() => void copyAppFailure(cwd, failure)}>
            Copy to paste elsewhere
          </Action>
          <Action data-app-action="show-output" onSelect={() => showAppOutput(cwd, crashed ? processKey(crashed.name) : "prepare")}>
            Show what it printed
          </Action>
          <Action data-app-action="restart" onSelect={() => (crashed ? driver?.restart(cwd) : driver?.start(cwd))}>
            {crashed ? "Restart" : "Try again"}
          </Action>
        </>
      ) : view.phase === "waiting" ? (
        <>
          {view.room?.apps ? (
            <Action data-app-action="make-room" onSelect={() => driver?.makeRoom(cwd)}>
              Stop the other {view.room.apps === 1 ? "app" : `${view.room.apps} apps`} and start this one
            </Action>
          ) : null}
          <Action data-app-action="stop-waiting" onSelect={() => driver?.stop(cwd)}>
            Stop waiting
          </Action>
        </>
      ) : (
        <Action data-app-action="stop" onSelect={() => driver?.stop(cwd)}>
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
      if (!crashed && view.prepare?.exit)
        return <Head title="Install failed">{`${view.prepare.command} stopped with code ${view.prepare.exit.code}, so the app didn't start.`}</Head>
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
          {`Your Mac is short on memory, so the app starts by itself once there's room.${
            view.room?.apps ? ` ${view.room.apps === 1 ? "Another app is" : `${view.room.apps} other apps are`} using ${formatBytes(view.room.bytes)}.` : ""
          }`}
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
      {view.prepare ? (
        <Row
          mark={view.prepare.exit ? "failed" : "running"}
          title="Install"
          detail={view.prepare.exit ? `Exited with ${view.prepare.exit.code}` : view.prepare.command}
          hint="Show output"
          onSelect={() => showAppOutput(cwd, "prepare")}
        />
      ) : null}
      {view.processes.map((process) => (
        <ProcessRow key={process.name} process={process} onSelect={() => showAppOutput(cwd, processKey(process.name))} />
      ))}
      {view.checks.map((check) => (
        <Fragment key={check.tier}>
          <CheckRow
            check={check}
            now={now}
            onSelect={() => {
              if (check.state === "never") threadAppDriver()?.runCheck(cwd, check.tier)
              showAppOutput(cwd, `check:${check.tier}`)
            }}
          />
          {check.steps?.some((step) => step.state !== "never")
            ? check.steps.map((step) => (
                <StepRow
                  key={step.name}
                  step={step}
                  onSelect={() => {
                    if (step.state === "never") threadAppDriver()?.runCheck(cwd, check.tier, [step.name])
                    showAppOutput(cwd, stepKey(check.tier, step.name))
                  }}
                />
              ))
            : null}
        </Fragment>
      ))}
    </>
  )
}

function Row({ mark, title, detail, hint, inset, onSelect }: { mark: Mark; title: string; detail?: ReactNode; hint?: ReactNode; inset?: boolean; onSelect: () => void }) {
  return (
    <MenuItem onSelect={onSelect} data-app-row={title} className={cn("group", inset && "min-h-7 pl-7 text-label")}>
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
  const hint = check.state === "never" ? "Run" : "Show output"
  return <Row mark={checkMark(check)} title={checkTitle(check.tier)} detail={detail} hint={hint} onSelect={onSelect} />
}

/** One of a check's named steps, under its check: how long it took, or where it is. */
function StepRow({ step, onSelect }: { step: AppCheckStepView; onSelect: () => void }) {
  const detail =
    step.state === "never" ? "Not run" : step.state === "waiting" ? "Waiting" : step.state === "running" ? "Running" : step.ms !== undefined ? formatDuration(step.ms) : undefined
  const hint = step.state === "never" ? "Run" : "Show output"
  return <Row inset mark={stepMark(step)} title={step.name} detail={detail} hint={hint} onSelect={onSelect} />
}

/** A recipe with more than one target offers a pick of what Run starts. */
function picking(view: Ready): boolean {
  return (view.targets?.length ?? 0) > 1
}

/** The other half of the Run button: which of the recipe's targets it runs. Picking one runs it. */
function TargetPicker({ cwd, targets, target }: { cwd: string; targets: string[]; target: string }) {
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          data-app-control="pick-target"
          aria-label="Choose what to run"
          className={cn(trigger, "rounded-l-none px-1 text-faint hover:text-foreground data-[state=open]:text-foreground")}
        >
          <ChevronDownIcon aria-hidden className="size-3" strokeWidth={2.5} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-48" onCloseAutoFocus={(event) => event.preventDefault()}>
        <MenuLabel>Run</MenuLabel>
        <TargetChoices targets={targets} target={target} onPick={(next) => { pickTarget(cwd, next); threadAppDriver()?.start(cwd) }} />
      </MenuContent>
    </Menu>
  )
}

/** Picking the target already checked runs it too, so each item acts on select rather than on a change of value. */
function TargetChoices({ targets, target, onPick }: { targets: string[]; target: string; onPick: (target: string) => void }) {
  return (
    <MenuRadioGroup value={target}>
      {targets.map((name) => (
        <MenuRadioItem key={name} value={name} data-app-target={name} onSelect={() => onPick(name)}>
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  )
}
