import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { FileWarningIcon, PlusIcon, SearchIcon, WorkflowIcon } from "lucide-react"
import type { AutomationProjectReading, AutomationTemplate } from "@mako/host/contracts/automations"
import { AutomationEditor } from "@/components/automations/automation-editor"
import { AutomationPage } from "@/components/automations/automation-page"
import { AutomationRow, ProposedRow } from "@/components/automations/automation-row"
import { TRIGGER_ICONS } from "@/components/automations/trigger-icons"
import { Action, Keys } from "@/components/ui/kit"
import { Skeleton } from "@/components/ui/skeleton"
import { everyWhileShown } from "@/lib/window-shown"
import { hasSchedule, needsYou, projectName, readTriggers, triggersLine } from "@/lib/automation-words"
import { cn } from "@/lib/utils"
import { automations, useAutomations } from "@/state/automations"
import { automationsBack, automationsViewStore, goAutomations, useAutomationsView, type AutomationsFilter } from "@/state/automations-view"
import { useInboxView } from "@/state/inbox-view"
import { useSession } from "@/state/session"
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
      {route.kind === "list" ? <ListPage /> : route.kind === "detail" ? <AutomationPage key={`${route.project}#${route.id}`} project={route.project} id={route.id} /> : route.kind === "new" ? <NewPage project={route.project} /> : <AutomationEditor key={`${route.project}#${route.id ?? "new"}#${route.source}`} route={route} />}
    </section>
  )
}

const FILTERS: Array<{ value: AutomationsFilter; label: string; key: string }> = [
  { value: "all", label: "All", key: "1" },
  { value: "scheduled", label: "Scheduled", key: "2" },
  { value: "needs", label: "Needs you", key: "3" },
  { value: "paused", label: "Paused", key: "4" },
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

function ListPage() {
  const loaded = useAutomations((state) => state.loaded)
  const failed = useAutomations((state) => state.failed)
  const projects = useAutomations((state) => state.projects)
  const filter = useAutomationsView((state) => state.filter)
  const query = useAutomationsView((state) => state.query)
  const now = useMinute()
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const counts = useMemo(() => {
    const count = (filter: AutomationsFilter) => projects.reduce((sum, reading) => sum + matches(reading, filter, "").length, 0)
    return { all: count("all"), scheduled: count("scheduled"), needs: count("needs"), paused: count("paused") }
  }, [projects])
  const total = counts.all
  const on = projects.reduce((sum, reading) => sum + reading.automations.filter((view) => view.local.enabled).length, 0)
  const proposed = projects.reduce((sum, reading) => sum + reading.proposals.filter((proposal) => proposal.status === "pending").length, 0)
  const groups = projects.map((reading) => ({ reading, views: matches(reading, filter, query), creates: filter === "all" || filter === "needs" ? reading.proposals.filter((proposal) => proposal.status === "pending" && proposal.change === "create" && !query) : [] }))

  // The row the keyboard was on comes back with the list.
  useEffect(() => {
    const focused = automationsViewStore.get().focused
    const row = (focused && list.current?.querySelector<HTMLElement>(`[data-automation-row="${CSS.escape(focused)}"]`)) || list.current?.querySelector<HTMLElement>("[data-automation-row]")
    row?.focus({ preventScroll: false })
  }, [loaded])

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = event.target instanceof HTMLElement && event.target.matches("input, textarea, select")
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const filterKey = FILTERS.find((each) => each.key === event.key)
      if (filterKey) {
        automationsViewStore.set({ filter: filterKey.value })
        event.preventDefault()
        return
      }
      if (event.key === "/") {
        search.current?.focus()
        event.preventDefault()
        return
      }
      if (event.key.toLowerCase() === "n") {
        goAutomations({ kind: "new" })
        event.preventDefault()
        return
      }
    }
    const down = event.key === "ArrowDown" || (!typing && event.key === "j")
    const up = event.key === "ArrowUp" || (!typing && event.key === "k")
    if (!down && !up) return
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-automation-row]") ?? [])]
    if (!rows.length) return
    const at = rows.findIndex((row) => row === document.activeElement)
    const next = rows[at === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (down ? 1 : -1)))]
    next?.focus()
    if (next) automationsViewStore.set({ focused: next.dataset.automationRow })
    event.preventDefault()
  }

  const summary = [total ? `${total} ${total === 1 ? "automation" : "automations"}` : undefined, on ? `${on} on` : undefined, proposed ? `${proposed} ${proposed === 1 ? "proposal" : "proposals"} to decide` : undefined].filter(Boolean).join(" · ")

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      <header className="flex shrink-0 items-start gap-3 px-5 pt-3.5 pb-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-semibold text-foreground">Automations</h1>
          <p data-automations-summary className={cn("text-label", proposed ? "text-attention" : "text-faint")}>
            {summary || "Agents that start on a schedule, a commit or an event"}
          </p>
        </div>
        <Action tone="outline" data-automation-new onClick={() => goAutomations({ kind: "new" })} title="New automation (N)">
          <PlusIcon />
          New
          <Keys keys={["N"]} />
        </Action>
      </header>
      {total || proposed ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-2">
          <div role="tablist" aria-label="Show" className="flex h-7 items-center bg-raised p-[2px]">
            {FILTERS.map((each) => (
              <button
                key={each.value}
                type="button"
                role="tab"
                data-automations-filter={each.value}
                aria-selected={filter === each.value}
                title={`${each.label} (${each.key})`}
                onClick={() => automationsViewStore.set({ filter: each.value })}
                className={cn("flex h-full items-center gap-1.5 px-2.5 text-label font-medium transition-colors", filter === each.value ? "bg-surface text-foreground" : "text-faint hover:text-muted-foreground")}
              >
                {each.label}
                {counts[each.value] ? <span className={cn("tabular", each.value === "needs" ? "text-attention" : "text-faint")}>{counts[each.value]}</span> : null}
              </button>
            ))}
          </div>
          <label className="ml-auto flex h-7 w-56 items-center gap-1.5 bg-raised px-2 text-faint focus-within:ring-1 focus-within:ring-border">
            <SearchIcon aria-hidden className="size-3.5 shrink-0" />
            <input
              ref={search}
              data-automations-search
              aria-label="Search automations"
              placeholder="Search automations"
              className="min-w-0 flex-1 bg-transparent text-label text-foreground placeholder:text-faint focus:outline-none"
              value={query}
              onChange={(event) => automationsViewStore.set({ query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault()
                  automationsViewStore.set({ query: "" })
                } else if (event.key === "ArrowDown" || event.key === "Enter") {
                  event.preventDefault()
                  list.current?.querySelector<HTMLElement>("[data-automation-row]")?.focus()
                }
              }}
            />
            <Keys keys={["/"]} />
          </label>
        </div>
      ) : null}
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[800px] flex-col px-5 pt-2 pb-10">
          {!loaded ? (
            <div className="flex flex-col gap-2 pt-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : failed ? (
            <p data-automations-failed className="pt-16 text-center text-ui text-negative">Mako couldn't read automations: {failed}</p>
          ) : !total && !proposed ? (
            <EmptyState />
          ) : (
            <>
              {groups.map(({ reading, views, creates }) =>
                views.length || creates.length || (filter === "all" && !query && (reading.file.error || reading.file.legacy)) ? (
                  <section key={reading.project} data-automations-project={reading.project} aria-label={projectName(reading.project)} className="pb-4">
                    <h2 className="flex h-8 items-center gap-2 px-2 text-label">
                      <span className="font-medium text-muted-foreground">{projectName(reading.project)}</span>
                      <span className="min-w-0 truncate text-faint" title={reading.project}>
                        {reading.project.replace(/^\/Users\/[^/]+/, "~")}
                      </span>
                      <span className="ml-auto shrink-0 tabular text-faint">{views.length}</span>
                      <button type="button" title={`New automation in ${projectName(reading.project)}`} aria-label={`New automation in ${projectName(reading.project)}`} onClick={() => goAutomations({ kind: "new", project: reading.project })} className="pressable flex size-6 shrink-0 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground">
                        <PlusIcon className="size-3.5" />
                      </button>
                    </h2>
                    <FileNote reading={reading} />
                    {creates.map((proposal) => (
                      <ProposedRow key={proposal.id} proposal={proposal} />
                    ))}
                    {views.map((view) => (
                      <AutomationRow key={view.definition.id} view={view} proposals={reading.proposals.filter((proposal) => proposal.automation === view.definition.id && proposal.change !== "create")} now={now} />
                    ))}
                  </section>
                ) : null
              )}
              {groups.every((group) => !group.views.length && !group.creates.length) ? (
                <p data-automations-none className="pt-12 text-center text-ui text-faint">
                  {query ? `No automation matches “${query.trim()}”.` : filter === "needs" ? "Nothing needs you here." : filter === "paused" ? "None is paused." : "None runs on a schedule."}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** The project's file, when it isn't as it should be: unreadable, an older shape, or entries it skipped. */
function FileNote({ reading }: { reading: AutomationProjectReading }) {
  const { file } = reading
  if (!file.error && !file.legacy && !file.skipped?.length) return null
  return (
    <p data-automations-file={file.error ? "error" : file.legacy ? "legacy" : "skipped"} className={cn("mx-2 mb-1 flex items-start gap-1.5 text-label", file.error ? "text-negative" : "text-caution")}>
      <FileWarningIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>
        {file.error
          ? `.mako/automations.json can't be read, so none of its automations runs until it's fixed: ${file.error}`
          : file.legacy
            ? ".mako/automations.json is in the first shape. It reads as the new one; the next save writes the new shape."
            : `Kept as written but not read: ${file.skipped!.join("; ")}`}
      </span>
    </p>
  )
}

function useTemplates(): AutomationTemplate[] | null {
  const templates = useAutomations((state) => state.templates)
  useEffect(() => {
    void automations.loadTemplates()
  }, [])
  return templates
}

/** Nothing yet: what automations are, and the templates to start from. */
function EmptyState() {
  const templates = useTemplates()
  const project = useDefaultProject()
  return (
    <div data-automations-empty className="flex flex-col items-center gap-2 pt-12 text-center">
      <div className="mb-1 flex size-8 items-center justify-center bg-raised text-faint">
        <WorkflowIcon className="size-4" />
      </div>
      <p className="text-ui font-medium text-foreground">No automations yet</p>
      <p className="max-w-[44ch] text-ui leading-relaxed text-faint">An automation starts an agent for you: on a schedule, when a commit lands, or when you press Run now. Each run is a Thread of its own.</p>
      <div className="mt-4 w-full text-left">
        <TemplateGrid templates={templates} project={project} />
      </div>
    </div>
  )
}

function useDefaultProject(explicit?: string): string | undefined {
  const root = useSession((state) => state.git?.root)
  const first = useAutomations((state) => state.projects[0]?.project)
  return explicit ?? root ?? first
}

/** Blank, or a template: each says what it does and when it runs. */
function TemplateGrid({ templates, project }: { templates: AutomationTemplate[] | null; project: string | undefined }) {
  const start = (template?: AutomationTemplate) => {
    if (!project) return
    goAutomations(template ? { kind: "edit", project, seed: template.definition, source: "template", from: template.name } : { kind: "edit", project, seed: {}, source: "blank" })
  }
  return (
    <div data-automation-templates className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      <button type="button" data-template="blank" disabled={!project} onClick={() => start()} className="pressable flex min-h-20 flex-col items-start gap-1 bg-raised px-3.5 py-3 text-left transition-colors hover:bg-fill-selected disabled:opacity-50">
        <span className="flex items-center gap-1.5 text-ui font-medium text-foreground">
          <PlusIcon aria-hidden className="size-3.5" />
          Blank
        </span>
        <span className="text-label text-muted-foreground">Write the prompt and pick when it runs.</span>
      </button>
      {templates === null
        ? [0, 1, 2].map((index) => <Skeleton key={index} className="h-20 w-full" />)
        : templates.map((template) => {
            const first = (template.definition.triggers ?? []).find((trigger) => trigger.kind !== "manual")
            const Icon = TRIGGER_ICONS[first?.kind ?? "manual"]
            return (
              <button key={template.key} type="button" data-template={template.key} disabled={!project} onClick={() => start(template)} className="pressable flex min-h-20 flex-col items-start gap-1 bg-raised px-3.5 py-3 text-left transition-colors hover:bg-fill-selected disabled:opacity-50">
                <span className="flex min-w-0 items-center gap-1.5 text-ui font-medium text-foreground">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{template.name}</span>
                </span>
                <span className="line-clamp-2 text-label text-muted-foreground">{template.summary}</span>
                <span className="truncate text-label text-faint">{triggersLine({ triggers: readTriggers(template.definition.triggers) ?? [] })}</span>
              </button>
            )
          })}
    </div>
  )
}

/** Starting points: which project, then blank or a template; "Make this an automation" starts from a Thread instead. */
function NewPage({ project: asked }: { project?: string }) {
  const templates = useTemplates()
  const projects = useAutomations((state) => state.projects.map((reading) => reading.project))
  const fallback = useDefaultProject(asked)
  const [project, setProject] = useState(fallback)
  const chosen = project ?? fallback
  return (
    <div data-automations-new className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-5 pt-3.5 pb-2">
        <h1 className="text-title font-semibold text-foreground">New automation</h1>
        <p className="text-label text-faint">Start blank or from a template. From a Thread, its menu's “Make this an automation” starts from what it was asked.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-3 px-5 pt-2 pb-10">
          <label className="flex items-center gap-2 text-label text-muted-foreground">
            In
            <select aria-label="Project" data-new-project className="h-7 bg-raised px-2 text-label text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-border" value={chosen ?? ""} onChange={(event) => setProject(event.target.value)}>
              {[...new Set([...(chosen ? [chosen] : []), ...projects])].map((each) => (
                <option key={each} value={each}>
                  {projectName(each)} — {each}
                </option>
              ))}
            </select>
          </label>
          <TemplateGrid templates={templates} project={chosen} />
        </div>
      </div>
    </div>
  )
}

