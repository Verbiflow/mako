import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileWarningIcon, PlusIcon, SparklesIcon } from "lucide-react"
import type { AutomationProjectReading, AutomationProposal, AutomationTemplate, AutomationView } from "@mako/host/contracts/automations"
import { AutomationEditor } from "@/components/automations/automation-editor"
import { AutomationPage } from "@/components/automations/automation-page"
import { AutomationReviewHost } from "@/components/automations/automation-review"
import { AutomationRow, ProposedRow } from "@/components/automations/automation-row"
import { TRIGGER_ICONS } from "@/components/automations/trigger-icons"
import { Action, Keys } from "@/components/ui/kit"
import { ListPage, ListSearch, ListSection, ListToolbar, ViewChips, type ListView } from "@/components/ui/list"
import { Skeleton } from "@/components/ui/skeleton"
import { useListKeys } from "@/components/ui/use-list-keys"
import { automationFix } from "@/lib/automation-fix"
import { everyWhileShown } from "@/lib/window-shown"
import { hasSchedule, lowerFirst, needsYou, nextRunOf, projectName, readTriggers, shortTriggers, triggersLine } from "@/lib/automation-words"
import { cn } from "@/lib/utils"
import { automations, automationsStore, automationView, useAutomations } from "@/state/automations"
import { automationsBack, automationsViewStore, closeAutomations, editAutomation, goAutomations, rowKey, showAutomation, useAutomationsView, type AutomationsFilter } from "@/state/automations-view"
import { desktop } from "@/state/desktop"
import { useInboxView } from "@/state/inbox-view"
import { actions, useSession } from "@/state/session"
import { useWindowRoutes } from "@/state/window-routes"

/** The pane repaints its ages and next runs once a minute, never per token. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => everyWhileShown(60_000, () => setNow(Date.now())), [])
  return now
}

/**
 * Automations over the conversation, as the Inbox is: the list by project, one automation's runs and proposals, the
 * starting points for a new one, and the editor, each a page of this one pane. Escape goes back a page.
 */
export function AutomationsView() {
  const open = useInboxView((state) => state.automations)
  const routed = useWindowRoutes((state) => state.routes !== null)
  if (!open || routed) return null
  return <AutomationsPane />
}

function AutomationsPane() {
  const route = useAutomationsView((state) => state.route)
  useEffect(() => {
    if (route.kind === "edit") return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (document.querySelector("[role=dialog], [role=menu]")) return
      // Escape in the search clears it first.
      if (event.target instanceof HTMLInputElement && event.target.matches("[data-automations-search]") && event.target.value) return
      event.preventDefault()
      automationsBack()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [route.kind])
  return (
    <section data-automations={route.kind} aria-label="Automations" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-surface">
      {route.kind === "list" ? <AutomationsList /> : route.kind === "detail" ? <AutomationPage key={`${route.project}#${route.id}`} project={route.project} id={route.id} /> : route.kind === "new" ? <NewPage project={route.project} /> : <AutomationEditor key={`${route.project}#${route.id ?? "new"}#${route.source}`} route={route} />}
      <AutomationReviewHost />
    </section>
  )
}

const FILTERS: Array<ListView<AutomationsFilter>> = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "needs", label: "Needs you" },
  { value: "paused", label: "Paused" },
]

function matches(reading: AutomationProjectReading, filter: AutomationsFilter, query: string) {
  const words = query.trim().toLowerCase()
  return reading.automations.filter((view) => {
    if (words && !`${view.definition.name} ${view.definition.id} ${triggersLine(view.definition)} ${view.definition.prompt.objective}`.toLowerCase().includes(words)) return false
    switch (filter) {
      case "all":
        return true
      case "scheduled":
        return hasSchedule(view.definition)
      case "needs":
        return needsYou(view, reading.proposals)
      case "paused":
        return view.standing === "paused"
    }
  })
}

interface Entry {
  view: AutomationView
  proposals: readonly AutomationProposal[]
}

interface Groups {
  needs: Entry[]
  next: Entry[]
  paused: Entry[]
}

/** The list's groups: what needs the person, then what runs next (soonest first), then what's off or paused. */
function groupsOf(entries: readonly Entry[], now: number): Groups {
  const needs: Entry[] = []
  const rest: Entry[] = []
  for (const entry of entries) (automationFix(entry.view, entry.proposals, () => undefined) ? needs : rest).push(entry)
  const resting = (entry: Entry) => entry.view.activeRun?.status !== "fired" && (entry.view.standing === "off" || entry.view.standing === "paused" || entry.view.standing === "unsupported")
  const soon = (entry: Entry) => (entry.view.activeRun?.status === "fired" ? 0 : nextRunOf(entry.view, now)?.at ?? Number.POSITIVE_INFINITY)
  const next = rest.filter((entry) => !resting(entry)).sort((left, right) => soon(left) - soon(right) || left.view.definition.name.localeCompare(right.view.definition.name))
  return { needs, next, paused: rest.filter(resting) }
}

/** `project#id` back to its parts; the id is the part after the last `#`. */
function splitKey(key: string): { project: string; id: string } | undefined {
  if (key.startsWith("proposed:")) return undefined
  const at = key.lastIndexOf("#")
  return at > 0 ? { project: key.slice(0, at), id: key.slice(at + 1) } : undefined
}

/** A project file the reader couldn't take whole, said once (its shape being old is the log's, not the list's). */
const toldLegacy = new Set<string>()

function AutomationsList() {
  const loaded = useAutomations((state) => state.loaded)
  const failed = useAutomations((state) => state.failed)
  const projects = useAutomations((state) => state.projects)
  const filter = useAutomationsView((state) => state.filter)
  const query = useAutomationsView((state) => state.query)
  const selected = useAutomationsView((state) => state.focused)
  const checked = useAutomationsView((state) => state.checked)
  const templatesOpen = useAutomationsView((state) => state.templatesOpen)
  const now = useMinute()
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const reviewing = useAutomationsView((state) => state.reviewing)
  const select = useCallback((key: string | undefined) => automationsViewStore.set({ focused: key }), [])
  const review = useCallback((key: string) => automationsViewStore.set({ focused: key, reviewing: automationsViewStore.get().reviewing === key ? undefined : key }), [])
  const counts = useMemo(() => {
    const count = (filter: AutomationsFilter) => projects.reduce((sum, reading) => sum + matches(reading, filter, "").length, 0)
    return { all: count("all"), scheduled: count("scheduled"), needs: count("needs"), paused: count("paused") }
  }, [projects])
  const total = counts.all
  const on = projects.reduce((sum, reading) => sum + reading.automations.filter((view) => view.local.enabled).length, 0)
  const proposed = projects.reduce((sum, reading) => sum + reading.proposals.filter((proposal) => proposal.status === "pending").length, 0)
  const creates = filter === "all" || filter === "needs" ? (query ? [] : projects.flatMap((reading) => reading.proposals.filter((proposal) => proposal.status === "pending" && proposal.change === "create"))) : []
  const entries = projects.flatMap((reading) => matches(reading, filter, query).map((view) => ({ view, proposals: reading.proposals.filter((proposal) => proposal.automation === view.definition.id && proposal.change !== "create") })))
  const groups = groupsOf(entries, now)
  const files = filter === "all" && !query ? projects.filter((reading) => reading.file.error || reading.file.skipped?.length) : []
  const showProject = projects.length > 1
  const empty = loaded && !failed && !total && !proposed

  useEffect(() => {
    for (const reading of projects)
      if (reading.file.legacy && !toldLegacy.has(reading.project)) {
        toldLegacy.add(reading.project)
        console.info(`[automations] ${reading.project}/.mako/automations.json is in the first shape; it reads as the new one and the next save writes the new shape.`)
      }
  }, [projects])

  const each = (key: string, run: (project: string, id: string) => void) => {
    const parts = splitKey(key)
    if (!parts) return false
    run(parts.project, parts.id)
    return true
  }
  const setEach = (enabled: boolean) => {
    for (const key of checked) each(key, (project, id) => void automations.setEnabled(project, id, enabled))
    automationsViewStore.set({ checked: [] })
  }

  useListKeys({
    root: list,
    enabled: loaded,
    selected,
    onSelect: select,
    onBack: automationsBack,
    onOpen: (key) => (key.startsWith("proposed:") ? review(key) : void each(key, showAutomation)),
    search,
    views: { count: FILTERS.length, pick: (index) => automationsViewStore.set({ filter: FILTERS[index]!.value }) },
    onCheck: (key) => {
      if (!splitKey(key)) return
      const held = automationsViewStore.get().checked
      automationsViewStore.set({ checked: held.includes(key) ? held.filter((each) => each !== key) : [...held, key] })
    },
    onKey: (event, key, typing) => {
      if (typing) {
        if (event.key !== "Escape" || !(event.target instanceof HTMLInputElement) || !event.target.matches("[data-automations-search]")) return false
        if (!query) return false
        automationsViewStore.set({ query: "" })
        return true
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return false
      if (event.key === "n") {
        goAutomations({ kind: "new" })
        return true
      }
      if (key === undefined) return false
      if (event.key === "e") return each(key, editAutomation)
      if (event.key === "r") return each(key, (project, id) => void automations.runNow(project, id))
      if (event.key === "t") return each(key, (project, id) => { const view = automationView(automationsStore.get(), project, id); if (view) void automations.setEnabled(project, id, !view.local.enabled) })
      if (event.key === "Backspace" || event.key === "Delete") return each(key, (project, id) => void automations.remove(project, id))
      return false
    },
  })

  const summary = [total ? `${total} ${total === 1 ? "automation" : "automations"}` : undefined, on ? `${on} on` : undefined, proposed ? `${proposed} ${proposed === 1 ? "proposal" : "proposals"} to decide` : undefined].filter(Boolean).join(" · ")
  const views = FILTERS.map((view) => ({ ...view, count: counts[view.value], attention: view.value === "needs" }))
  const row = ({ view, proposals }: Entry) => {
    const key = rowKey(view.project, view.definition.id)
    return <AutomationRow key={key} view={view} proposals={proposals} now={now} selected={selected === key} reviewing={reviewing === key} checked={checked.includes(key)} showProject={showProject} onSelect={select} onReview={review} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListPage
        scrollRef={list}
        title="Automations"
        summary={<span data-automations-summary>{summary || "Nothing runs on its own yet"}</span>}
        summaryTone={proposed ? "attention" : "faint"}
        actions={
          <Action data-automation-new onClick={() => goAutomations({ kind: "new" })} title="New automation (N)">
            <PlusIcon />
            New
            <Keys keys={["N"]} />
          </Action>
        }
        toolbar={
          empty || !loaded ? undefined : (
            <ListToolbar>
              {checked.length ? (
                <div data-automations-checked={checked.length} className="flex min-w-0 items-center gap-1 text-label">
                  <span className="px-2 font-medium text-foreground">{checked.length} selected</span>
                  <Action size="sm" data-automations-bulk="on" onClick={() => setEach(true)}>Turn on</Action>
                  <Action size="sm" data-automations-bulk="off" onClick={() => setEach(false)}>Turn off</Action>
                  <Action size="sm" onClick={() => automationsViewStore.set({ checked: [] })}>Clear</Action>
                </div>
              ) : (
                <ViewChips views={views} value={filter} onChange={(value) => automationsViewStore.set({ filter: value })} />
              )}
              <ListSearch
                ref={search}
                data-automations-search
                aria-label="Search automations"
                placeholder="Search"
                value={query}
                onChange={(event) => automationsViewStore.set({ query: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "Enter") return
                  event.preventDefault()
                  const first = list.current?.querySelector<HTMLElement>("[data-list-row]")
                  if (first) {
                    select(first.dataset.listRow)
                    first.focus()
                  }
                }}
              />
            </ListToolbar>
          )
        }
      >
        {!loaded ? (
          <div className="flex flex-col gap-1 pt-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : failed ? (
          <p data-automations-failed className="pt-16 text-center text-ui text-negative">Mako couldn't read automations: {failed}</p>
        ) : empty ? (
          <EmptyState />
        ) : (
          <>
            {creates.length || groups.needs.length || files.length ? (
              <ListSection label="Needs you" count={creates.length + groups.needs.length + files.length} attention data-automations-group="needs">
                {files.map((reading) => (
                  <FileNote key={reading.project} reading={reading} />
                ))}
                {creates.map((proposal) => (
                  <ProposedRow key={proposal.id} proposal={proposal} selected={selected === `proposed:${proposal.id}`} reviewing={reviewing === `proposed:${proposal.id}`} onSelect={select} onReview={review} />
                ))}
                {groups.needs.map(row)}
              </ListSection>
            ) : null}
            {groups.next.length ? (
              <ListSection label="Up next" count={groups.next.length} data-automations-group="next">
                {groups.next.map(row)}
              </ListSection>
            ) : null}
            {groups.paused.length ? (
              <ListSection label="Off and paused" count={groups.paused.length} data-automations-group="paused">
                {groups.paused.map(row)}
              </ListSection>
            ) : null}
            {!creates.length && !entries.length ? (
              <p data-automations-none className="py-12 text-center text-ui text-faint">
                {query ? `No automation matches “${query.trim()}”` : filter === "needs" ? "Nothing needs you here" : filter === "paused" ? "None is paused" : "None runs on a schedule"}
              </p>
            ) : null}
            <Templates open={templatesOpen ?? false} onFold={() => automationsViewStore.set({ templatesOpen: !(templatesOpen ?? false) })} />
          </>
        )}
      </ListPage>
    </div>
  )
}

/** A project's file the reader couldn't take whole: why, and the one action that fixes it, opening the file. */
function FileNote({ reading }: { reading: AutomationProjectReading }) {
  const { file } = reading
  const path = `${reading.project}/.mako/automations.json`
  return (
    <div data-automations-file={file.error ? "error" : "skipped"} className="flex min-h-10 min-w-0 items-center gap-2.5 px-2 py-2">
      <span className="flex size-4 shrink-0 items-center justify-center text-negative">
        <FileWarningIcon aria-hidden className="size-3.5" />
      </span>
      <span className={cn("min-w-0 flex-1 text-label", file.error ? "text-negative" : "text-caution")} title={path}>
        {file.error ? `${projectName(reading.project)}’s automations file can’t be read, so none of it runs: ${file.error}` : `${projectName(reading.project)}’s automations file has entries Mako can’t read: ${file.skipped!.join("; ")}`}
      </span>
      <Action size="xs" tone="quiet" data-automations-file-open onClick={() => void desktop.openInEditor(path)} className="text-label">
        Open file
      </Action>
    </div>
  )
}

function useTemplates(): AutomationTemplate[] | null {
  const templates = useAutomations((state) => state.templates)
  useEffect(() => {
    void automations.loadTemplates()
  }, [])
  return templates
}

/** A new Thread in the project with the words written in its composer: an automation is made by asking for one. */
async function describeInThread(project: string | undefined, words: string) {
  closeAutomations()
  // In the project it's for; with none known yet, where a new Thread would start anyway.
  if (!(await (project ? actions.newConversationIn(project) : actions.newSession()))) return
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:compose", { detail: { text: words } })))
}

const DESCRIBE = "Make an automation that "
const EXAMPLES = ["What should run on its own?", "Every weekday at 8:00, triage new issues and label them", "When a check fails on main, find why and open a fix", "Each Friday, update dependencies and open a pull request"]

/** Nothing yet: what should run on its own, in the person's words, then the templates. */
function EmptyState() {
  const project = useDefaultProject()
  const [words, setWords] = useState("")
  const [example, setExample] = useState(0)
  useEffect(() => everyWhileShown(5_000, () => setExample((at) => (at + 1) % EXAMPLES.length)), [])
  const describe = () => void describeInThread(project, `${DESCRIBE}${lowerFirst(words.trim())}`)
  return (
    <div data-automations-empty className="flex flex-col gap-6 pt-6">
      <form
        className="flex h-11 items-center gap-2 bg-raised px-3 shadow-(--elevation-composer)"
        onSubmit={(event) => {
          event.preventDefault()
          describe()
        }}
      >
        <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-faint" />
        <input
          data-automations-describe
          aria-label="What should run on its own?"
          autoFocus
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return
            event.preventDefault()
            describe()
          }}
          placeholder={EXAMPLES[example]}
          className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
        />
        <Keys keys={["↵"]} />
      </form>
      <Templates open onFold={undefined} />
    </div>
  )
}

function useDefaultProject(explicit?: string): string | undefined {
  const root = useSession((state) => state.git?.root)
  const first = useAutomations((state) => state.projects[0]?.project)
  return explicit ?? root ?? first
}

/** The starting points, always under the list: folded once there are automations, open while there are none. */
function Templates({ open, onFold, project: asked }: { open: boolean; onFold: (() => void) | undefined; project?: string }) {
  const templates = useTemplates()
  const project = useDefaultProject(asked)
  return (
    <ListSection label="Templates" count={templates ? templates.length : undefined} folded={!open} onFold={onFold} data-automations-group="templates">
      <TemplateGrid templates={templates} project={project} />
    </ListSection>
  )
}

const TILE = "pressable flex min-w-0 flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors duration-100 hover:bg-fill-hover disabled:opacity-50"

/** Describe it, blank, or a template: each says what it does and when it runs, a tone and never a box. */
function TemplateGrid({ templates, project }: { templates: AutomationTemplate[] | null; project: string | undefined }) {
  const start = (template?: AutomationTemplate) => {
    if (!project) return
    goAutomations(template ? { kind: "edit", project, seed: template.definition, source: "template", from: template.name } : { kind: "edit", project, seed: {}, source: "blank" })
  }
  return (
    <div data-automation-templates className="grid grid-cols-1 gap-x-2 gap-y-1 @lg/list:grid-cols-2">
      <button type="button" data-template="describe" onClick={() => void describeInThread(project, DESCRIBE)} className={TILE}>
        <span className="flex items-center gap-1.5 text-ui font-medium text-foreground">
          <SparklesIcon aria-hidden className="size-3.5 text-muted-foreground" />
          Describe it
        </span>
        <span className="text-label text-muted-foreground">Say what should run and when; a Thread makes it.</span>
      </button>
      <button type="button" data-template="blank" disabled={!project} onClick={() => start()} className={TILE}>
        <span className="flex items-center gap-1.5 text-ui font-medium text-foreground">
          <PlusIcon aria-hidden className="size-3.5 text-muted-foreground" />
          Blank
        </span>
        <span className="text-label text-muted-foreground">Write the prompt and pick when it runs.</span>
      </button>
      {templates === null
        ? [0, 1, 2].map((index) => <Skeleton key={index} className="h-16 w-full" />)
        : templates.map((template) => {
            const first = (template.definition.triggers ?? []).find((trigger) => trigger.kind !== "manual")
            const Icon = TRIGGER_ICONS[first?.kind ?? "manual"]
            const triggers = readTriggers(template.definition.triggers) ?? []
            return (
              <button key={template.key} type="button" data-template={template.key} disabled={!project} onClick={() => start(template)} className={TILE}>
                <span className="flex min-w-0 max-w-full items-center gap-1.5 text-ui font-medium text-foreground">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{template.name}</span>
                </span>
                <span className="line-clamp-2 text-label text-muted-foreground">{template.summary}</span>
                <span className="max-w-full truncate text-label text-faint" title={triggersLine({ triggers })}>{shortTriggers({ triggers })}</span>
              </button>
            )
          })}
    </div>
  )
}

/** Starting points: which project, then Describe it, blank or a template; "Make this an automation" starts from a Thread instead. */
function NewPage({ project: asked }: { project?: string }) {
  const projects = useAutomations((state) => state.projects.map((reading) => reading.project))
  const fallback = useDefaultProject(asked)
  const [project, setProject] = useState(fallback)
  const chosen = project ?? fallback
  const templates = useTemplates()
  return (
    <div data-automations-new className="flex min-h-0 flex-1 flex-col">
      <ListPage
        title="New automation"
        toolbar={
          <ListToolbar>
            <label className="flex h-7 items-center gap-1.5 px-2 text-label text-muted-foreground hover:bg-fill-hover">
              In
              <select aria-label="Project" data-new-project className="bg-transparent text-label font-medium text-foreground focus:outline-none" value={chosen ?? ""} onChange={(event) => setProject(event.target.value)}>
                {[...new Set([...(chosen ? [chosen] : []), ...projects])].map((each) => (
                  <option key={each} value={each}>
                    {projectName(each)}
                  </option>
                ))}
              </select>
            </label>
          </ListToolbar>
        }
      >
        <TemplateGrid templates={templates} project={chosen} />
      </ListPage>
    </div>
  )
}
