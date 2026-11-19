import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { ArrowLeftIcon, GitBranchIcon, ShareIcon, LaptopIcon } from "lucide-react"
import { ACCESS_TIERS, type AccessTier } from "@mako/host/contracts/access"
import {
  AutomationDefinitionSchema,
  branchFor,
  type AutomationDefinitionInput,
  type AutomationResult,
  type AutomationTrigger,
} from "@mako/host/contracts/automations"
import { TriggerList } from "@/components/automations/trigger-fields"
import { harnessLabel } from "@/components/rail/harness-meta"
import { Action, FIELD, Keys, Segmented, Toggle } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import {
  entriesOf,
  localTime,
  zoneDate,
  freeId,
  readTriggers,
  idFromName,
  localZone,
  nextRuns,
  projectName,
  RESULT_WORDS,
  scheduleOccurrenceOf,
  triggerSentence,
  WHEN_AWAY_WORDS,
} from "@/lib/automation-words"
import { useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { automations, automationsStore, automationView, useAutomations } from "@/state/automations"
import { automationsBack, goAutomations, type AutomationsRoute } from "@/state/automations-view"
import { confirmAction } from "@/state/confirm"
import { useHarnessOrder } from "@/state/harness-order"
import { providers, useProviders } from "@/state/providers"

/**
 * Making or changing an automation: its name, its prompt as a brief, its triggers as sentences, what it starts with,
 * its Thread, its gate, its limits and what a run leaves. Saving writes the project's `.mako/automations.json` through
 * the host, shared with everyone who has the repo; whether it's on stays on this Mac, and a new one starts off.
 * Problems show beside their field once it's been touched or a save was tried. ⌘S or ⌘↩ saves; Escape goes back.
 */

type EditRoute = Extract<AutomationsRoute, { kind: "edit" }>

interface Draft {
  project: string
  id: string
  idTouched: boolean
  name: string
  objective: string
  doneWhen: string
  boundaries: string
  output: string
  triggers: AutomationTrigger[]
  harness: string
  model: string
  reasoning: string
  rule?: number
  access: AccessTier
  place: "here" | "cloud" | "device"
  device: string
  whenAway: "cloud" | "queue" | "skip"
  worktree: boolean
  base: string
  branch: string
  thread: "new" | "standing"
  gate: boolean
  gateCommand: string
  gateTimeout: string
  overlap: "skip" | "queue"
  maxRunsPerDay: string
  timeoutMin: string
  tokenBudget: string
  result: AutomationResult
}

const REASONING = ["low", "medium", "high", "xhigh", "max"] as const

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean)
}

function draftOf(project: string, seed: Partial<AutomationDefinitionInput>, id: string | undefined): Draft {
  const start = seed.start ?? {}
  const place = start.place ?? "here"
  const limits = seed.limits ?? {}
  return {
    project,
    id: id ?? seed.id ?? "",
    idTouched: Boolean(id ?? seed.id),
    name: seed.name ?? "",
    objective: seed.prompt?.objective ?? "",
    doneWhen: (seed.prompt?.doneWhen ?? []).join("\n"),
    boundaries: (seed.prompt?.boundaries ?? []).join("\n"),
    output: seed.prompt?.output ?? "",
    triggers: readTriggers(seed.triggers) ?? [{ kind: "schedule", cron: "0 9 * * 1-5", timezone: localZone() }],
    harness: start.harness ?? "",
    model: start.model ?? "",
    reasoning: start.reasoning ?? "",
    ...(start.rule !== undefined && { rule: start.rule }),
    access: start.access ?? "edits",
    place: place === "here" || place === "cloud" ? place : "device",
    device: place.startsWith("device:") ? place.slice("device:".length) : "",
    whenAway: start.whenAway ?? "queue",
    worktree: start.workspace !== undefined,
    base: start.workspace?.base ?? "",
    branch: start.workspace?.branch ?? "",
    thread: seed.thread ?? "new",
    gate: seed.gate !== undefined,
    gateCommand: seed.gate?.command ?? "",
    gateTimeout: String(seed.gate?.timeoutS ?? 60),
    overlap: limits.overlap ?? "skip",
    maxRunsPerDay: limits.maxRunsPerDay ? String(limits.maxRunsPerDay) : "",
    timeoutMin: String(limits.timeoutMin ?? 60),
    tokenBudget: limits.tokenBudget ? String(limits.tokenBudget) : "",
    result: seed.result ?? "report",
  }
}

function numberOr(value: string): number | undefined {
  if (!value.trim()) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : Number.NaN
}

/** The definition a draft writes, as the file keeps it. */
function definitionOf(draft: Draft) {
  const doneWhen = lines(draft.doneWhen)
  const boundaries = lines(draft.boundaries)
  const maxRunsPerDay = numberOr(draft.maxRunsPerDay)
  const tokenBudget = numberOr(draft.tokenBudget)
  return {
    id: draft.id,
    name: draft.name.trim(),
    prompt: {
      objective: draft.objective.trim(),
      ...(doneWhen.length && { doneWhen }),
      ...(boundaries.length && { boundaries }),
      ...(draft.output.trim() && { output: draft.output.trim() }),
    },
    start: {
      ...(draft.harness && { harness: draft.harness }),
      ...(draft.model && { model: draft.model }),
      ...(draft.reasoning && { reasoning: draft.reasoning }),
      ...(draft.rule !== undefined && { rule: draft.rule }),
      access: draft.access,
      place: draft.place === "device" ? `device:${draft.device.trim()}` : draft.place,
      whenAway: draft.whenAway,
      ...(draft.worktree && { workspace: { ...(draft.base.trim() && { base: draft.base.trim() }), ...(draft.branch.trim() && { branch: draft.branch.trim() }) } }),
    },
    thread: draft.thread,
    triggers: draft.triggers,
    ...(draft.gate && { gate: { command: draft.gateCommand, timeoutS: numberOr(draft.gateTimeout) ?? 60 } }),
    limits: {
      overlap: draft.overlap,
      ...(maxRunsPerDay !== undefined && { maxRunsPerDay }),
      timeoutMin: numberOr(draft.timeoutMin) ?? 60,
      ...(tokenBudget !== undefined && { tokenBudget }),
    },
    result: draft.result,
  }
}

/** Problems by field: `name`, `id`, `objective`, `trigger:<n>`, `triggers`, `device`, `gate`, `limits.<key>`, … */
function problemsOf(draft: Draft, taken: ReadonlySet<string>): ReadonlyMap<string, string> {
  const problems = new Map<string, string>()
  const parsed = AutomationDefinitionSchema.safeParse(definitionOf(draft))
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, second, third] = issue.path
      const key =
        head === "prompt" ? String(second ?? "objective")
        : head === "triggers" && /^\d+$/.test(String(second)) ? `trigger:${String(second)}`
        : head === "start" && second === "place" ? "device"
        : head === "start" && second === "workspace" ? `workspace.${String(third ?? "branch")}`
        : head === "limits" ? `limits.${String(second)}`
        : head === "gate" ? (second === "timeoutS" ? "gate.timeout" : "gate")
        : String(head ?? "form")
      if (!problems.has(key)) problems.set(key, issue.message)
    }
  }
  if (!draft.name.trim()) problems.set("name", "Give it a name.")
  if (!draft.objective.trim()) problems.set("objective", "Say what each run should do.")
  if (draft.id && taken.has(draft.id)) problems.set("id", "Another automation in this project has this id.")
  if (!draft.triggers.length) problems.set("triggers", "Add at least one trigger; “Only by Run now” is one.")
  if (draft.place === "device" && !draft.device.trim()) problems.set("device", "Name the device it runs on.")
  if (draft.gate && !draft.gateCommand.trim()) problems.set("gate", "Write the command, or turn the gate off.")
  draft.triggers.forEach((trigger, index) => {
    if (trigger.kind === "github" && !/^[\w.-]+\/[\w.-]+$/.test(trigger.repo)) problems.set(`trigger:${index}`, "Name the repository as owner/repo.")
    if (trigger.kind === "webhook" && !trigger.secret) problems.set(`trigger:${index}`, "Name the secret your cloud account keeps; never its value.")
  })
  const timeoutMin = Number(draft.timeoutMin)
  if (problems.has("limits.timeoutMin") || !Number.isInteger(timeoutMin)) problems.set("limits.timeoutMin", "A whole number of minutes, 1 to 1440.")
  return problems
}

const LABEL = "text-ui font-medium text-foreground"
const HELP = "text-label leading-relaxed text-muted-foreground"
const TEXTAREA = "min-h-20 w-full resize-y bg-raised px-2.5 py-2 text-ui leading-relaxed text-foreground placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border [field-sizing:content]"

export function AutomationEditor({ route }: { route: EditRoute }) {
  useHarnessIdentity()
  const projects = useAutomations((state) => state.projects.map((reading) => reading.project))
  const existing = useAutomations((state) => (route.id ? automationView(state, route.project, route.id) : undefined))
  const cloudRegistered = existing?.local.cloudRegistered
  const [draft, setDraft] = useState<Draft>(() => {
    const seeded = draftOf(route.project, route.seed, route.id)
    if (route.id || seeded.idTouched) {
      if (!route.id) seeded.id = freeId(seeded.id, takenIds(route.project, undefined))
      return seeded
    }
    return { ...seeded, id: seeded.name ? freeId(idFromName(seeded.name), takenIds(route.project, undefined)) : "" }
  })
  const [baseline, setBaseline] = useState(() => JSON.stringify(draft))
  const [now] = useState(() => Date.now())
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const taken = useMemo(() => takenIds(draft.project, route.id), [draft.project, route.id])
  const problems = useMemo(() => problemsOf(draft, taken), [draft, taken])
  const shownProblem = (key: string) => (tried || touched[key] ? problems.get(key) : undefined)
  const dirty = JSON.stringify(draft) !== baseline

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => {
      const next = { ...current, [key]: value }
      // A new automation's id follows its name until the person writes one.
      if (key === "name" && !route.id && !current.idTouched) next.id = value ? freeId(idFromName(String(value)), takenIds(current.project, undefined)) : ""
      return next
    })
  const touch = (key: string) => setTouched((current) => (current[key] ? current : { ...current, [key]: true }))

  const save = async () => {
    setTried(true)
    if (saving) return
    const first = [...problems.keys()][0]
    if (first) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-field-problem="${CSS.escape(first)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }))
      return
    }
    const parsed = AutomationDefinitionSchema.safeParse(definitionOf(draft))
    if (!parsed.success) return
    setSaving(true)
    const replaces = route.id && route.id !== draft.id ? route.id : undefined
    const saved = await automations.save(draft.project, parsed.data, replaces)
    setSaving(false)
    if (!saved.ok) {
      toast.error("Couldn't save it", { description: saved.error })
      return
    }
    setBaseline(JSON.stringify(draft))
    const view = automationView(automationsStore.get(), draft.project, draft.id)
    const project = draft.project
    const id = draft.id
    toast(route.id ? `Saved ${draft.name.trim()}` : `Added ${draft.name.trim()}`, {
      duration: ACTION_TOAST_MS,
      description: view?.local.enabled ? "Written to .mako/automations.json" : "Written to .mako/automations.json; it's off on this Mac until you turn it on",
      ...(!view?.local.enabled && { action: { label: "Turn on", onClick: () => void automations.setEnabled(project, id, true) } }),
    })
    goAutomations({ kind: "detail", project, id })
  }

  const leave = async () => {
    if (dirty && !(await confirmAction({ title: "Leave without saving?", body: "Your changes to this automation aren't saved anywhere.", confirm: "Discard changes", tone: "negative" }))) return
    automationsBack()
  }

  const keys = useRef({ save, leave })
  useEffect(() => {
    keys.current = { save, leave }
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && (event.key === "s" || event.key === "Enter")) {
        event.preventDefault()
        void keys.current.save()
      } else if (event.key === "Escape" && !document.querySelector("[role=dialog], [role=menu]")) {
        event.preventDefault()
        void keys.current.leave()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])

  useEffect(() => {
    void providers.loadAll()
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-automation-name]")?.focus())
  }, [])

  const heading = route.id ? `Edit ${existing?.definition.name ?? route.seed.name ?? "automation"}` : route.source === "thread" ? "Make this an automation" : route.source === "duplicate" ? `Copy of ${route.from ?? "an automation"}` : route.source === "template" ? `New from “${route.from ?? "a template"}”` : "New automation"
  const triggerProblems = Object.fromEntries(draft.triggers.flatMap((_, index) => (shownProblem(`trigger:${index}`) ? [[index, shownProblem(`trigger:${index}`)!]] : [])))

  return (
    <div data-automation-editor={route.id ?? "new"} className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-5 pt-3 pb-2">
        <button type="button" onClick={() => void leave()} aria-label="Back" title="Back (Esc)" className="pressable flex size-7 items-center justify-center text-muted-foreground hover:bg-fill-hover hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-semibold text-foreground">{heading}</h1>
          <p className="truncate text-label text-faint">
            {route.source === "thread" && route.from ? `From the Thread “${route.from}” · ` : null}
            {projectName(draft.project)} · .mako/automations.json
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          className="mx-auto flex w-full max-w-[680px] flex-col gap-7 px-5 pt-3 pb-10"
        >
          <Summary draft={draft} />

          <Block title="Name">
            <input
              data-automation-name
              aria-label="Name"
              aria-invalid={Boolean(shownProblem("name")) || undefined}
              className={cn(FIELD, "h-9 w-full text-title")}
              placeholder="Nightly dependency check"
              maxLength={120}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
              onBlur={() => touch("name")}
            />
            <Problem field="name" text={shownProblem("name")} />
            <div className="flex min-w-0 items-center gap-2 text-label text-faint">
              {route.id ? null : (
                <>
                  <span className="shrink-0">Project</span>
                  <select aria-label="Project" data-automation-project className={cn(FIELD, "h-7 max-w-64 text-label")} value={draft.project} onChange={(event) => set("project", event.target.value)}>
                    {[...new Set([draft.project, ...projects])].map((project) => (
                      <option key={project} value={project}>
                        {projectName(project)} — {project}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <span className="shrink-0">Id</span>
              <input
                aria-label="Id"
                data-automation-id
                className={cn(FIELD, "h-7 w-56 font-mono text-label")}
                spellCheck={false}
                value={draft.id}
                onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value.toLowerCase(), idTouched: true }))}
                onBlur={() => touch("id")}
              />
            </div>
            <Problem field="id" text={shownProblem("id") ?? (draft.id ? undefined : tried ? "Give it an id." : undefined)} />
            {route.id && draft.id !== route.id ? <p className="text-label text-caution">Renaming the id starts its run history and its on/off afresh on every Mac.</p> : null}
          </Block>

          <Block title="What each run does" help="The brief its agent gets, as an Apex would start a Fin.">
            <Labeled label="Objective">
              <textarea
                aria-label="Objective"
                data-automation-objective
                aria-invalid={Boolean(shownProblem("objective")) || undefined}
                className={cn(TEXTAREA, "min-h-28")}
                placeholder="Read last night's failed CI runs on main, find the cause of each, and fix the ones that are ours."
                value={draft.objective}
                onChange={(event) => set("objective", event.target.value)}
                onBlur={() => touch("objective")}
              />
              <Problem field="objective" text={shownProblem("objective")} />
            </Labeled>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Labeled label="Done when" hint="One a line">
                <textarea aria-label="Done when" className={TEXTAREA} placeholder={"Every failure has a cause\nThe fix's tests pass"} value={draft.doneWhen} onChange={(event) => set("doneWhen", event.target.value)} />
              </Labeled>
              <Labeled label="Boundaries" hint="One a line">
                <textarea aria-label="Boundaries" className={TEXTAREA} placeholder={"Don't touch the release branch\nNo new dependencies"} value={draft.boundaries} onChange={(event) => set("boundaries", event.target.value)} />
              </Labeled>
            </div>
            <Labeled label="Its report says">
              <input aria-label="Output" className={cn(FIELD, "w-full")} placeholder="Each failure, its cause, and the pull request that fixes it" value={draft.output} onChange={(event) => set("output", event.target.value)} />
            </Labeled>
          </Block>

          <Block title="When it runs" help="Any of these starts a run. Run now always works, whatever's here.">
            <TriggerList triggers={draft.triggers} cloudRegistered={cloudRegistered} problems={triggerProblems} onChange={(next) => set("triggers", next)} />
            <Problem field="triggers" text={shownProblem("triggers") ?? (tried ? problems.get("triggers") : undefined)} />
          </Block>

          <Block title="What it starts" help="The harness, model and access its Thread starts with, and where.">
            <StartFields now={now} draft={draft} set={set} problem={shownProblem("device")} />
          </Block>

          <Block title="Thread">
            <Choice
              name="thread"
              value={draft.thread}
              onChange={(value) => set("thread", value)}
              options={[
                { value: "new", label: "A new Thread each run", detail: "Each run starts clean, its Thread named for the run." },
                { value: "standing", label: "One standing Thread", detail: "Every run is the next message in the same Thread, so it remembers the last." },
              ]}
            />
          </Block>

          <Block title="Gate" help="A cheap command run first in the project folder: exit 0 runs, exit 1 skips quietly, anything else fails. A JSON object it prints is the run's context; its key stops a repeat.">
            <div className="flex items-center gap-2.5">
              <Toggle label="Check first with a command" on={draft.gate} onChange={() => set("gate", !draft.gate)} />
              <span className="text-ui text-foreground">Check first with a command</span>
            </div>
            {draft.gate ? (
              <div className="flex flex-col gap-2">
                <input
                  aria-label="Gate command"
                  data-gate-command
                  className={cn(FIELD, "w-full font-mono text-label")}
                  spellCheck={false}
                  placeholder={'gh run list --branch main --status failure --json databaseId --jq \'if length > 0 then {key: .[0].databaseId|tostring} else halt_error(1) end\''}
                  value={draft.gateCommand}
                  onChange={(event) => set("gateCommand", event.target.value)}
                  onBlur={() => touch("gate")}
                />
                <Problem field="gate" text={shownProblem("gate")} />
                <label className="flex items-center gap-2 text-label text-muted-foreground">
                  Gives up after
                  <input aria-label="Gate timeout in seconds" type="number" min={1} max={900} className={cn(FIELD, "h-7 w-20 tabular")} value={draft.gateTimeout} onChange={(event) => set("gateTimeout", event.target.value)} />
                  seconds
                </label>
                <Problem field="gate.timeout" text={problems.get("gate.timeout")} />
              </div>
            ) : null}
          </Block>

          <Block title="Limits">
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Labeled label="While a run is going">
                <Segmented
                  label="While a run is going"
                  value={draft.overlap}
                  onChange={(value) => set("overlap", value)}
                  options={[
                    { value: "skip", label: "Skip" },
                    { value: "queue", label: "Queue" },
                  ]}
                />
              </Labeled>
              <NumberField label="Runs a day, at most" placeholder="No cap" value={draft.maxRunsPerDay} onChange={(value) => set("maxRunsPerDay", value)} problem={shownProblem("limits.maxRunsPerDay") ?? (tried ? problems.get("limits.maxRunsPerDay") : undefined)} field="limits.maxRunsPerDay" min={1} max={96} />
              <NumberField label="Stop a run after" unit="minutes" value={draft.timeoutMin} onChange={(value) => set("timeoutMin", value)} problem={tried || touched["limits.timeoutMin"] ? problems.get("limits.timeoutMin") : undefined} field="limits.timeoutMin" min={1} max={1440} onBlur={() => touch("limits.timeoutMin")} />
              <NumberField label="Tokens a run may spend" placeholder="No budget" unit="tokens" value={draft.tokenBudget} onChange={(value) => set("tokenBudget", value)} problem={tried ? problems.get("limits.tokenBudget") : undefined} field="limits.tokenBudget" min={10000} step={10000} />
            </div>
          </Block>

          <Block title="What a run leaves">
            <Choice
              name="result"
              value={draft.result}
              onChange={(value) => set("result", value)}
              options={entriesOf(RESULT_WORDS).map(([value, words]) => ({ value, label: words.label, detail: words.detail }))}
            />
            {draft.result === "pull-request" && !draft.worktree ? <p className="text-label text-caution">A pull request needs a branch of its own: turn on “Its own worktree” above.</p> : null}
          </Block>
        </form>
      </div>
      <footer className="flex shrink-0 items-center gap-3 bg-shell px-5 py-2.5">
        <p data-shared-note className="flex min-w-0 flex-1 items-center gap-3 text-label text-faint">
          <span className="flex min-w-0 items-center gap-1.5" title="Committed with the repository: everyone who has it sees this definition">
            <ShareIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">Shared with the repo</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5" title="Whether it runs is your choice on each Mac; a clone never turns it on">
            <LaptopIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">On or off is this Mac’s</span>
          </span>
        </p>
        <Action tone="ghost" onClick={() => void leave()}>
          Cancel
        </Action>
        <Action tone="solid" data-automation-save disabled={saving} onClick={() => void save()}>
          {route.id ? "Save" : "Add automation"}
          <Keys keys={formatChord("mod+s")} inverted />
        </Action>
      </footer>
    </div>
  )
}

function takenIds(project: string, except: string | undefined): Set<string> {
  const reading = automationsStore.get().projects.find((each) => each.project === project)
  return new Set((reading?.automations ?? []).map((view) => view.definition.id).filter((id) => id !== except))
}

/** The automation in one sentence, as it would run if saved now. */
function Summary({ draft }: { draft: Draft }) {
  const first = draft.triggers.find((trigger) => trigger.kind !== "manual")
  const when = first ? lowerFirstWord(triggerSentence(first)) : "only when you press Run now"
  const harness = draft.harness ? harnessLabel(draft.harness) : "your first harness with room"
  const where = draft.place === "cloud" ? "in the cloud" : draft.place === "device" ? `on ${draft.device || "another device"}` : "on this Mac"
  const leaves = { "pull-request": "opens a pull request", report: "reports back in its Thread", act: "makes its changes directly" }[draft.result]
  const next = first?.kind === "schedule" ? nextRuns(first.cron, first.timezone, 1)[0] : undefined
  const more = draft.triggers.filter((trigger) => trigger.kind !== "manual").length - 1
  return (
    <p data-automation-summary className="bg-raised px-3.5 py-2.5 text-ui leading-relaxed text-muted-foreground">
      <span className="text-foreground">{draft.name.trim() || "This automation"}</span> runs {when}
      {more > 0 ? ` (and ${more} more ${more === 1 ? "way" : "ways"})` : ""}, starts {harness} with {ACCESS_TIERS.find((tier) => tier.tier === draft.access)?.label.toLowerCase() ?? draft.access} {where}
      {draft.worktree ? " in its own worktree" : ""}, and {leaves}.{next && first?.kind === "schedule" ? ` First run ${zoneDate(next, first.timezone)}${localTime(next, first.timezone) ? ` (${localTime(next, first.timezone)})` : ""}, once it's on.` : ""}
    </p>
  )
}

function lowerFirstWord(sentence: string): string {
  return sentence.replace(/^(Every|When|On|Only)\b/, (word) => word.toLowerCase())
}

function StartFields({ now, draft, set, problem }: { now: number; draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void; problem?: string }) {
  const order = useHarnessOrder()
  const models = useProviders((state) => (draft.harness ? state.profiles[draft.harness]?.models : undefined))
  const branchPreview = useMemo(() => {
    if (!draft.branch.trim()) return undefined
    const schedule = draft.triggers.find((trigger) => trigger.kind === "schedule")
    const at = (schedule?.kind === "schedule" ? nextRuns(schedule.cron, schedule.timezone, 1)[0] : undefined) ?? now
    return branchFor(draft.branch, { id: draft.id || "automation", occurrence: scheduleOccurrenceOf(at), at, ...(schedule?.kind === "schedule" && { timezone: schedule.timezone }) })
  }, [draft.branch, draft.id, draft.triggers, now])
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Labeled label="Harness">
          <select aria-label="Harness" data-start-harness className={cn(FIELD, "w-full")} value={draft.harness} onChange={(event) => { set("harness", event.target.value); set("model", "") }}>
            <option value="">First with room</option>
            {[...new Set([...order, ...(draft.harness ? [draft.harness] : [])])].map((harness) => (
              <option key={harness} value={harness}>
                {harnessLabel(harness)}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Model">
          <select aria-label="Model" data-start-model className={cn(FIELD, "w-full")} value={draft.model} disabled={!draft.harness} onChange={(event) => set("model", event.target.value)}>
            <option value="">{draft.harness ? "Its default" : "Pick a harness first"}</option>
            {draft.model && !models?.some((model) => model.id === draft.model) ? <option value={draft.model}>{draft.model}</option> : null}
            {(models ?? []).map((model) => (
              <option key={model.id} value={model.id} disabled={Boolean(model.unavailable)}>
                {model.label}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Reasoning">
          <select aria-label="Reasoning" className={cn(FIELD, "w-full")} value={draft.reasoning} onChange={(event) => set("reasoning", event.target.value)}>
            <option value="">Its default</option>
            {[...new Set([...REASONING, ...(draft.reasoning ? [draft.reasoning] : [])])].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Labeled>
      </div>
      <Labeled label="Access" hint={ACCESS_TIERS.find((tier) => tier.tier === draft.access)?.summary}>
        <select aria-label="Access" data-start-access className={cn(FIELD, "w-full sm:w-72")} value={draft.access} onChange={(event) => {
          const tier = ACCESS_TIERS.find((each) => each.tier === event.target.value)?.tier
          if (tier) set("access", tier)
        }}>
          {ACCESS_TIERS.map((tier) => (
            <option key={tier.tier} value={tier.tier}>
              {tier.label}
            </option>
          ))}
        </select>
      </Labeled>
      {draft.access === "full" ? <p className="-mt-1 text-label text-caution">Nothing waits for approval on full access. Give it its own worktree.</p> : null}
      <Labeled label="Runs on">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Runs on"
            value={draft.place}
            onChange={(value) => set("place", value)}
            options={[
              { value: "here", label: "This Mac" },
              { value: "cloud", label: "Cloud" },
              { value: "device", label: "Another device" },
            ]}
          />
          {draft.place === "device" ? <input aria-label="Device name" data-field-problem="device" className={cn(FIELD, "h-7 w-48")} placeholder="Studio" value={draft.device} onChange={(event) => set("device", event.target.value)} /> : null}
        </div>
        <Problem field="device" text={problem} />
      </Labeled>
      {draft.place !== "cloud" && draft.triggers.some((trigger) => ["github", "slack", "linear", "sentry", "webhook"].includes(trigger.kind)) ? (
        <Labeled label="If this Mac is off when a cloud trigger fires" hint="Schedules and commits fire on this Mac; GitHub, Slack, Linear, Sentry and webhooks fire in your cloud account.">
          <Segmented
            label="If this Mac is off"
            value={draft.whenAway}
            onChange={(value) => set("whenAway", value)}
            options={entriesOf(WHEN_AWAY_WORDS).map(([value, label]) => ({ value, label }))}
          />
        </Labeled>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Toggle label="Its own worktree" on={draft.worktree} onChange={() => set("worktree", !draft.worktree)} />
          <span className="text-ui text-foreground">Its own worktree</span>
          <span className="text-label text-faint">{draft.worktree ? "A branch per run, out of your way" : "Works in the project folder"}</span>
        </div>
        {draft.worktree ? (
          <div className="grid grid-cols-1 gap-3 pl-[38px] sm:grid-cols-2">
            <Labeled label="From">
              <input aria-label="Base" className={cn(FIELD, "w-full font-mono text-label")} placeholder="main" value={draft.base} onChange={(event) => set("base", event.target.value)} />
            </Labeled>
            <Labeled label="Branch" hint="{date}, {time}, {automation} and {run} are filled in each run">
              <input aria-label="Branch template" data-branch-template className={cn(FIELD, "w-full font-mono text-label")} placeholder="auto/{automation}/{date}" value={draft.branch} onChange={(event) => set("branch", event.target.value)} />
            </Labeled>
            {branchPreview ? (
              <p className="flex items-center gap-1.5 text-label text-faint sm:col-span-2">
                <GitBranchIcon aria-hidden className="size-3" />
                Next run's branch: <span data-branch-preview className="font-mono text-muted-foreground">{branchPreview}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Block({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div>
        <h2 className={LABEL}>{title}</h2>
        {help ? <p className={HELP}>{help}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="flex items-baseline gap-2 text-label text-muted-foreground">
        {label}
        {hint ? <span className="text-faint">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}

function Problem({ field, text }: { field: string; text?: string }) {
  if (!text) return null
  return (
    <p role="alert" data-field-problem={field} className="text-label text-negative">
      {text}
    </p>
  )
}

function NumberField({ label, unit, placeholder, value, onChange, problem, field, min, max, step, onBlur }: { label: string; unit?: string; placeholder?: string; value: string; onChange: (value: string) => void; problem?: string; field: string; min?: number; max?: number; step?: number; onBlur?: () => void }) {
  return (
    <Labeled label={label}>
      <span className="flex items-center gap-2">
        <input type="number" aria-label={label} data-number-field={field} className={cn(FIELD, "w-32 tabular")} placeholder={placeholder} min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />
        {unit ? <span className="text-label text-faint">{unit}</span> : null}
      </span>
      <Problem field={field} text={problem} />
    </Labeled>
  )
}

/** A few choices, each a line with its explanation; arrow keys move between them as radios do. */
function Choice<T extends string>({ name, value, onChange, options }: { name: string; value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string; detail: string }> }) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-col gap-1">
      {options.map((option) => (
        <label key={option.value} data-choice={`${name}:${option.value}`} className={cn("pressable flex cursor-default items-start gap-2.5 px-2.5 py-2 transition-colors", value === option.value ? "bg-fill-selected" : "hover:bg-fill-hover")}>
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="mt-1 size-3 shrink-0 accent-[var(--foreground)]" />
          <span className="min-w-0">
            <span className="block text-ui text-foreground">{option.label}</span>
            <span className="block text-label text-muted-foreground">{option.detail}</span>
          </span>
        </label>
      ))}
    </div>
  )
}
