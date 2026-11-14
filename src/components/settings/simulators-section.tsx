import { useEffect, useState, type ReactNode } from "react"
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, CopyIcon, SmartphoneIcon } from "lucide-react"
import { toast } from "sonner"
import { setupStep, type SetupFix, type SetupStep, type SetupStepId, type SimulatorSetup } from "@mako/host/contracts/simulator-setup"
import { Action, Chip, Eyebrow, ListCard, ListCardRow, Meter, Toggle } from "@/components/ui/kit"
import { Collapse } from "@/components/ui/collapse"
import { Shimmer } from "@/components/ui/shimmer"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useSession } from "@/state/session"
import { simulatorSetup, useSimulatorSetup } from "@/state/simulator-setup"

/**
 * Settings › Simulators: iPhone and iPad simulators on this Mac, from nothing to one agents can drive, as one calm
 * surface. Mako does every step it can and says what it's doing; the two that are the person's (their Apple ID for
 * Xcode, their password for Xcode's license) are said as what to do, with macOS's own prompts. Once set up, the same
 * card is the status: healthy, or what broke with the one press that repairs it.
 */
export function SimulatorsSection() {
  const setup = useSimulatorSetup((state) => state.setup)
  useEffect(() => {
    simulatorSetup.load()
    // Xcode lands while the person is in the App Store: coming back to the window is when to look again.
    const back = () => simulatorSetup.load(true)
    window.addEventListener("focus", back)
    return () => window.removeEventListener("focus", back)
  }, [])
  if (!setup)
    return (
      <p data-simulators-reading className="px-1 py-6 text-ui text-faint">
        <Shimmer>Looking at this Mac…</Shimmer>
      </p>
    )
  return (
    <div className="flex flex-col gap-6">
      <SetupCard setup={setup} />
      <AgentAccess setup={setup} />
    </div>
  )
}

function SetupCard({ setup }: { setup: SimulatorSetup }) {
  const said = useSummary(setup)
  const [steps, setSteps] = useState(setup.phase !== "ready")
  const [details, setDetails] = useState(false)
  const settled = setup.phase === "ready" || setup.phase === "unavailable"
  return (
    <section data-simulators={setup.phase} className="bg-raised/40 px-5 pt-5 pb-2">
      <div className="flex items-center gap-4">
        <SimulatorMark state={said.mark} />
        <div className="min-w-0 flex-1">
          <h3 data-simulators-headline className="flex items-center gap-2 text-title font-medium tracking-[-0.01em] text-foreground">
            {said.headline}
            {setup.phase === "ready" ? <Chip tone="positive">Healthy</Chip> : null}
          </h3>
          <p data-simulators-now className="mt-1 text-ui leading-snug text-pretty text-muted-foreground">
            {said.going ? <Shimmer>{said.line}</Shimmer> : said.line}
          </p>
        </div>
        {said.action}
      </div>
      {setup.phase === "unavailable" ? null : settled ? (
        <>
          <Disclosure open={steps} onToggle={() => setSteps(!steps)} data="steps">
            Setup
          </Disclosure>
          <Collapse open={steps}>
            <Steps setup={setup} />
          </Collapse>
        </>
      ) : (
        <div className="mt-5">
          <Steps setup={setup} />
        </div>
      )}
      <Disclosure open={details} onToggle={() => setDetails(!details)} data="details">
        Details
      </Disclosure>
      <Collapse open={details}>
        <Details setup={setup} />
      </Collapse>
    </section>
  )
}

function Disclosure({ open, onToggle, data, children }: { open: boolean; onToggle: () => void; data: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-simulators-toggle={data}
      className="pressable mt-3 -ml-1 flex items-center gap-1 px-1 py-1 text-label text-faint hover:text-muted-foreground"
    >
      <ChevronRightIcon className={cn("size-3 transition-transform duration-200 ease-[var(--ease-out)]", open && "rotate-90")} />
      {children}
    </button>
  )
}

type MarkState = "idle" | "working" | "ready" | "broken"

/** A phone, wearing the line's state as an app icon wears a badge. */
function SimulatorMark({ state }: { state: MarkState }) {
  return (
    <span data-simulators-mark={state} className="relative flex size-11 shrink-0 items-center justify-center bg-background text-muted-foreground shadow-xs" aria-hidden>
      <SmartphoneIcon className="size-5" strokeWidth={1.6} />
      {state === "idle" ? null : (
        <span
          className={cn(
            "absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full shadow-xs",
            state === "ready" && "bg-positive text-background",
            state === "broken" && "bg-caution text-background",
            state === "working" && "bg-background text-muted-foreground"
          )}
        >
          {state === "ready" ? <CheckIcon className="size-[10px]" strokeWidth={3.2} /> : state === "broken" ? <span className="text-label leading-none font-medium">!</span> : <Spinner className="size-[11px]" />}
        </span>
      )}
    </span>
  )
}

/* What the card says */

type Summary = { headline: string; line: string; going: boolean; mark: MarkState; action?: ReactNode }

function useSummary(setup: SimulatorSetup): Summary {
  const pressing = useSimulatorSetup((state) => state.pressing)
  const reading = useSimulatorSetup((state) => state.reading)
  const working = setup.steps.find((step) => step.state === "working")
  if (setup.phase === "unavailable")
    return { headline: "Simulators", line: "iPhone and iPad simulators run on a Mac with Xcode. Open Mako on your Mac to set them up there.", going: false, mark: "idle" }
  if (setup.phase === "ready") {
    const runtime = setupStep(setup, "runtime")?.runtime
    const names = setupStep(setup, "simulators")?.simulators.map((simulator) => simulator.name.replace(/^Mako /, "")) ?? []
    return {
      headline: "Simulators are ready",
      line: `${joinWords(names)} on ${runtime?.name ?? "iOS"}. Agents use them in the projects you allow.`,
      going: false,
      mark: "ready",
      action: (
        <Action tone="outline" size="md" disabled={reading} onClick={() => simulatorSetup.load(true)} data-simulators-fix="check">
          {reading ? <Spinner /> : null}
          {reading ? "Checking" : "Check again"}
        </Action>
      ),
    }
  }
  const next = nextStep(setup)
  if (setup.phase === "broken") {
    const broke = setup.steps.find((step) => step.state === "stuck")
    return {
      headline: "Simulators need a repair",
      line: working ? workingLine(setup, working) : broke?.problem ?? "Something they need went missing.",
      going: Boolean(working),
      mark: working ? "working" : "broken",
      action: next?.fix ? <FixAction fix={next.fix} tone="solid" size="md" label="Repair" busy={pressing === next.fix} /> : undefined,
    }
  }
  if (working) return { headline: "Setting up simulators", line: workingLine(setup, working), going: true, mark: "working" }
  return {
    headline: "Set up iPhone and iPad simulators",
    line: "Agents open your web app in Safari on a real iOS Simulator, touch it and read the page, and you watch here or from your phone.",
    going: false,
    mark: "idle",
  }
}

/** The step the person meets next: stuck before waiting, in the order of the line. */
function nextStep(setup: SimulatorSetup): SetupStep | undefined {
  return setup.steps.find((step) => step.state === "stuck" && step.fix) ?? setup.steps.find((step) => step.state === "yours" && step.fix)
}

function workingLine(setup: SimulatorSetup, step: SetupStep): string {
  const progress = setup.progress?.step === step.id ? setup.progress : undefined
  switch (step.id) {
    case "xcode":
      return "Waiting for Xcode from the App Store. Mako notices when it lands."
    case "finish":
      return "Finishing Xcode's setup. macOS may be asking for your password."
    case "runtime": {
      const wanted = step.wanted ? `iOS ${step.wanted}` : "iOS"
      if (progress?.doneBytes !== undefined && progress.totalBytes) return `Downloading ${wanted}: ${size(progress.doneBytes)} of ${size(progress.totalBytes)}`
      return progress?.fraction !== undefined ? `Downloading ${wanted}: ${Math.round(progress.fraction * 100)}%` : `Downloading ${wanted}…`
    }
    case "simulators":
      return "Making Mako's iPhone and iPad…"
    case "tools":
      return "Installing the simulator tools…"
    case "agents":
      return "Saving who may use them…"
    case "try":
      return "Booting the iPhone and opening Safari…"
  }
}

/* The steps */

function Steps({ setup }: { setup: SimulatorSetup }) {
  const next = nextStep(setup)
  return (
    <ol data-simulators-steps className="flex flex-col">
      {setup.steps.map((step, index) => (
        <StepRow key={step.id} setup={setup} step={step} index={index} primary={step === next} />
      ))}
    </ol>
  )
}

function StepRow({ setup, step, index, primary }: { setup: SimulatorSetup; step: SetupStep; index: number; primary: boolean }) {
  const pressing = useSimulatorSetup((state) => state.pressing)
  const refused = useSimulatorSetup((state) => state.refused)
  const said = stepWords(step)
  const failure = setup.failure && fixStep(setup.failure.fix) === step.id ? setup.failure.message : undefined
  const progress = step.state === "working" && setup.progress?.step === step.id ? setup.progress : undefined
  // Waiting for Xcode isn't work under way: the tools can install meanwhile, and the App Store can be opened again.
  const busy = setup.steps.some((other) => other.state === "working" && other.id !== "xcode")
  const offered = step.fix && step.id !== "agents" && (step.state === "yours" || step.state === "stuck" || (step.id === "xcode" && step.state === "working"))
  return (
    <li data-simulators-step={step.id} data-state={step.state} className="flex items-start gap-3 py-3.5">
      <StepGlyph state={step.state} index={index} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-ui font-medium", step.state === "later" ? "text-faint" : "text-foreground")}>{said.title}</p>
        {said.detail ? <p className="mt-0.5 text-label leading-relaxed text-pretty text-muted-foreground">{said.detail}</p> : null}
        {step.problem && step.state !== "done" ? (
          <p data-simulators-problem className={cn("mt-1 text-label leading-relaxed text-pretty", step.state === "stuck" ? "text-caution" : "text-faint")}>
            {step.problem}
          </p>
        ) : null}
        {progress ? (
          <div className="mt-2 flex items-center gap-3">
            <Meter value={progress.fraction ?? 0} className="max-w-64" />
            <span className="text-label text-faint tabular-nums">{progress.fraction !== undefined ? `${Math.round(progress.fraction * 100)}%` : ""}</span>
          </div>
        ) : null}
        {step.id === "tools" ? <ToolList step={step} /> : null}
        {failure ? <p data-simulators-failure className="mt-1 text-label leading-relaxed text-pretty text-negative">{failure}</p> : null}
        {primary && refused ? <p className="mt-1 text-label text-negative">{refused}</p> : null}
      </div>
      {offered && step.fix ? (
        <div className="shrink-0 self-center">
          <FixAction fix={step.fix} tone={primary ? "solid" : "outline"} size="sm" label={said.action} busy={pressing === step.fix} disabled={busy || (pressing !== undefined && pressing !== step.fix)} />
        </div>
      ) : step.state === "working" ? (
        <Spinner className="mt-1 size-3.5 shrink-0 text-faint" />
      ) : null}
    </li>
  )
}

function StepGlyph({ state, index }: { state: SetupStep["state"]; index: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-label tabular-nums",
        state === "done" && "bg-positive/12 text-positive",
        state === "working" && "bg-background text-muted-foreground",
        state === "yours" && "bg-background text-foreground ring-1 ring-foreground/25",
        state === "stuck" && "bg-caution/12 text-caution",
        state === "later" && "text-faint bg-raised"
      )}
    >
      {state === "done" ? <CheckIcon className="size-3" strokeWidth={3} /> : state === "stuck" ? <AlertTriangleIcon className="size-3" /> : state === "working" ? <Spinner className="size-3" /> : index + 1}
    </span>
  )
}

function FixAction({ fix, tone, size, label, busy, disabled }: { fix: SetupFix; tone: "solid" | "outline"; size: "sm" | "md"; label: string; busy: boolean; disabled?: boolean }) {
  return (
    <Action tone={tone} size={size} disabled={busy || disabled} onClick={() => void simulatorSetup.press(fix)} data-simulators-fix={fix}>
      {busy ? <Spinner /> : null}
      {label}
    </Action>
  )
}

function ToolList({ step }: { step: Extract<SetupStep, { id: "tools" }> }) {
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {step.tools.map((tool) => (
        <li key={tool.name} data-simulators-tool={tool.name} className="flex items-baseline gap-2 text-label">
          <span className="font-mono text-muted-foreground">{tool.name}</span>
          <span className="text-faint tabular-nums">{tool.version}</span>
          <span className="truncate text-faint">{tool.purpose}</span>
          {tool.installed && tool.installed !== tool.version ? <Chip tone="caution">{tool.installed} installed</Chip> : null}
        </li>
      ))}
    </ul>
  )
}

/** A step in the person's words: what it is, what it needs from them, and what its button says. */
interface StepWords {
  title: string
  detail?: string
  action: string
}

function stepWords(step: SetupStep): StepWords {
  switch (step.id) {
    case "xcode":
      if (step.xcode) return { title: `Xcode ${step.xcode.version}`, detail: step.xcode.path, action: "" }
      return {
        title: "Get Xcode",
        detail:
          step.state === "working"
            ? "Install it from the App Store with your Apple ID. Mako looks for it as you come back."
            : `Free from the App Store with your Apple ID. It needs about ${size(step.disk.needBytes)} free with the iOS runtime; this Mac has ${size(step.disk.freeBytes)}.`,
        action: step.state === "working" ? "Open App Store" : "Get Xcode",
      }
    case "finish":
      if (step.state === "done") return { title: "Xcode is set up", detail: "Chosen as the developer folder, license accepted, components installed.", action: "" }
      return {
        title: "Finish Xcode's setup",
        detail: "Chooses this Xcode, accepts its license and installs its components, in one go. macOS asks for an administrator's password; Mako never sees it.",
        action: "Finish setup",
      }
    case "runtime":
      if (step.runtime) return { title: step.runtime.name, detail: "The iOS Simulator runtime.", action: "" }
      return { title: `Download ${step.wanted ? `iOS ${step.wanted}` : "iOS"}`, detail: "The iOS Simulator runtime, about 8 GB from Apple.", action: "Download" }
    case "simulators": {
      const names = step.simulators.map((simulator) => simulator.name)
      if (step.state === "done") return { title: "Mako's iPhone and iPad", detail: joinWords(names), action: "" }
      return {
        title: "Make an iPhone and an iPad",
        detail: names.length ? `${joinWords(names)}, named for Mako so your own simulators are left alone.` : "An iPhone Pro and a 13-inch iPad Pro, named for Mako so your own simulators are left alone.",
        action: "Make them",
      }
    }
    case "tools":
      if (step.state === "done") return { title: "Simulator tools", detail: "Installed at the versions Mako checked, in Mako's own folder.", action: "" }
      return { title: "Install the simulator tools", detail: "Pinned versions, in Mako's own folder. They don't need Xcode, so they can go first.", action: "Install" }
    case "agents":
      return {
        title: "Choose where agents can use them",
        detail: step.projects.some((project) => project.allowed) ? `Allowed in ${joinWords(step.projects.filter((project) => project.allowed).map((project) => folderName(project.folder)))}.` : "Below, per project. Until you allow one, no agent is offered a simulator.",
        action: "",
      }
    case "try":
      if (step.state === "done") return { title: "Tried", detail: step.firstFrameMs !== undefined ? `Safari's first frame showed here in ${(step.firstFrameMs / 1000).toFixed(1)} s.` : undefined, action: "" }
      return { title: "Try it", detail: "Boots the iPhone, opens Mako in Safari and streams it here.", action: "Try it" }
  }
}

function fixStep(fix: SetupFix): SetupStepId {
  const steps = {
    "get-xcode": "xcode",
    "finish-xcode": "finish",
    "download-runtime": "runtime",
    "create-simulators": "simulators",
    "install-tools": "tools",
    "allow-agents": "agents",
    try: "try",
  } satisfies Record<SetupFix, SetupStepId>
  return steps[fix]
}

/* Agents */

/**
 * Agents' use of simulators, per project and revocable: the project open now first, then each one answered before.
 * A Thread's tools only appear in a project allowed here.
 */
function AgentAccess({ setup }: { setup: SimulatorSetup }) {
  const cwd = useSession((state) => state.meta?.cwd)
  const pressing = useSimulatorSetup((state) => state.pressing)
  const projects = setupStep(setup, "agents")?.projects ?? []
  if (setup.phase === "unavailable") return null
  const rows = [...(cwd && !projects.some((project) => project.folder === cwd) ? [{ folder: cwd, allowed: false, at: 0 }] : []), ...projects]
  return (
    <section data-simulators-agents className="flex flex-col gap-2">
      <Eyebrow>Agent access</Eyebrow>
      {rows.length ? (
        <ListCard>
          {rows.map((project) => (
            <ListCardRow key={project.folder} className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui text-foreground">{folderName(project.folder)}</p>
                <p className="truncate text-label text-faint">{project.at ? project.folder : `${project.folder} · not asked yet`}</p>
              </div>
              <Toggle
                label={`Agents in ${folderName(project.folder)} can use simulators`}
                on={project.allowed}
                disabled={pressing !== undefined}
                onChange={() => void simulatorSetup.press("allow-agents", { folder: project.folder, allowed: !project.allowed })}
              />
            </ListCardRow>
          ))}
        </ListCard>
      ) : (
        <p className="px-1 text-label text-faint">Open a project, and it's listed here to allow.</p>
      )}
      <p className="px-1 text-label leading-relaxed text-pretty text-faint">
        An agent drives one simulator at a time, and only one Thread drives it; the rest watch. Yours to take over from the panel at any time.
      </p>
    </section>
  )
}

/* Details */

function Details({ setup }: { setup: SimulatorSetup }) {
  const xcode = setupStep(setup, "xcode")
  const finish = setupStep(setup, "finish")
  const runtime = setupStep(setup, "runtime")
  const simulators = setupStep(setup, "simulators")
  const tools = setupStep(setup, "tools")
  const rows: Array<{ label: string; value: string }> = [
    { label: "Mac", value: setup.mac },
    { label: "Developer folder", value: xcode?.developerDir ?? "None" },
    { label: "Xcode", value: xcode?.xcode ? `${xcode.xcode.version}${xcode.xcode.build ? ` (${xcode.xcode.build})` : ""}, ${xcode.xcode.path}` : "Not installed" },
    { label: "License", value: checkWords(finish?.license) },
    { label: "First launch", value: checkWords(finish?.firstLaunch) },
    { label: "iOS runtime", value: runtime?.runtime ? `${runtime.runtime.name}${runtime.runtime.build ? ` (${runtime.runtime.build})` : ""}` : runtime?.wanted ? `iOS ${runtime.wanted} wanted, not installed` : "Not installed" },
    { label: "Simulators", value: simulators?.simulators.filter((simulator) => simulator.udid).map((simulator) => `${simulator.name} ${simulator.udid}`).join(", ") || "None made" },
    { label: "Tools", value: tools?.tools.map((tool) => `${tool.name} ${tool.installed ?? "missing"} (${tool.license})`).join(", ") ?? "" },
    { label: "Disk", value: xcode ? `${size(xcode.disk.freeBytes)} free, ${size(xcode.disk.needBytes)} needed` : "" },
  ]
  return (
    <div data-simulators-details className="pt-1 pb-3">
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-1 py-2 text-label">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-faint">{row.label}</dt>
            <dd className="break-words text-muted-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-end px-1 pt-1">
        <Action size="xs" onClick={() => copyDetails(setup)} data-simulators-copy>
          <CopyIcon />
          Copy details
        </Action>
      </div>
    </div>
  )
}

function checkWords(state: "done" | "needed" | "unknown" | undefined): string {
  return state === "done" ? "Done" : state === "needed" ? "Needed" : "Asked once Xcode is here"
}

function copyDetails(setup: SimulatorSetup) {
  const lines = [`phase ${setup.phase}`, setup.mac, ...setup.steps.map((step) => [step.id, step.state, step.problem ?? ""].filter(Boolean).join("  ")), ...(setup.failure ? [`last failure ${setup.failure.fix}: ${setup.failure.message}`] : [])]
  void navigator.clipboard.writeText(lines.join("\n")).then(
    () => toast("Details copied"),
    () => toast.error("The details weren't copied")
  )
}

/** As Apple and the App Store say sizes: in thousands, so 7.35 GB here is 7.35 GB there. */
function size(bytes: number): string {
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`
  return `${(bytes / 1e9).toFixed(bytes < 10e9 ? 2 : 0)} GB`
}

function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).at(-1) ?? folder
}

function joinWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}
