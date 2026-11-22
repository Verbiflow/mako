import { useEffect, useState, type ReactNode } from "react"
import { ArrowLeftIcon, CloudIcon, CopyIcon, PencilLineIcon, PlayIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
import { AutomationRuns } from "@/components/automations/automation-runs"
import { ProposalBlock } from "@/components/automations/automation-proposal"
import { NextRuns } from "@/components/automations/trigger-fields"
import { TRIGGER_ICONS } from "@/components/automations/trigger-icons"
import { harnessLabel } from "@/components/rail/harness-meta"
import { Action, Keys, Toggle } from "@/components/ui/kit"
import { limitFacts, nextRunOf, nextRunTitle, zoneDate, projectName, RESULT_WORDS, standingNote, startFacts, triggerWaits, triggerWithCondition } from "@/lib/automation-words"
import { useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { approvedNow, automations, automationView, useAutomations } from "@/state/automations"
import { AutomationDiff } from "@/components/automations/automation-diff"
import { z } from "zod"
import { automationsBack, duplicateAutomation, editAutomation, goAutomations } from "@/state/automations-view"
import { localWords } from "@mako/protocol/computer-words"

/**
 * One automation: its switch, Run now and Edit at the top; a proposal for it, answerable; then when it runs (each
 * trigger as its sentence, a schedule's next three runs), what it does and starts with, and its runs. Keys: E edits,
 * R runs it now, T turns it on or off, D duplicates; Escape goes back to the list.
 */
const JSON_VALUE = z.json()

export function AutomationPage({ project, id }: { project: string; id: string }) {
  useHarnessIdentity()
  const view = useAutomations((state) => automationView(state, project, id))
  const proposals = useAutomations((state) => state.projects.find((reading) => reading.project === project)?.proposals.filter((proposal) => proposal.automation === id && proposal.change !== "create"))
  const [now] = useState(() => Date.now())
  useEffect(() => {
    if (!view) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || target?.matches("input, textarea, select, [role=menuitem]")) return
      const key = event.key.toLowerCase()
      if (key === "e") editAutomation(project, id)
      else if (key === "r") void automations.runNow(project, id)
      else if (key === "t") void automations.setEnabled(project, id, !view.local.enabled)
      else if (key === "d") duplicateAutomation(project, id)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [project, id, view])
  if (!view) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ui text-faint">
        <p>This automation isn't in {projectName(project)}'s file any more.</p>
        <Action tone="outline" onClick={() => goAutomations({ kind: "list" })}>
          Back to Automations
        </Action>
      </div>
    )
  }
  const { definition, local } = view
  const next = nextRunOf(view, now)
  const note = standingNote(view)
  const pending = (proposals ?? []).filter((proposal) => proposal.status === "pending")
  const decided = (proposals ?? []).filter((proposal) => proposal.status !== "pending").slice(0, 5)
  const brief = definition.prompt
  const gateFacts: Array<[string, string]> = definition.gate ? [["Gate", definition.gate.command], ["Gate gives up", `after ${definition.gate.timeoutS} s`]] : [["Gate", "None: every trigger runs"]]
  return (
    <div data-automation-page={definition.id} className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-5 pt-3 pb-2">
        <button type="button" onClick={automationsBack} aria-label="Back to Automations" title="Back (Esc)" className="pressable flex size-7 items-center justify-center text-muted-foreground hover:bg-fill-hover hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-semibold text-foreground">{definition.name}</h1>
          <p className="truncate text-label text-faint">
            {projectName(project)} · {definition.id} · {next ? <span data-page-next title={nextRunTitle(next)}>next {zoneDate(next.at, next.zone)}</span> : local.enabled ? (view.standing === "paused" ? "paused" : definition.triggers.some((trigger) => trigger.kind !== "manual") ? "starts when its triggers fire" : "only by Run now") : localWords("off on this Mac")}
          </p>
        </div>
        <label className="flex items-center gap-2 pr-1 text-label text-muted-foreground" title={localWords("Whether it runs on this Mac (T)")}>
          <Toggle label={localWords(`${definition.name} on this Mac`)} on={local.enabled} onChange={() => void automations.setEnabled(project, id, !local.enabled)} />
          <span data-automation-switch-words>{local.enabled ? "On" : "Off"} {localWords("on this Mac")}</span>
        </label>
        <Action tone="outline" data-automation-page-run onClick={() => void automations.runNow(project, id)} title="Run now (R)">
          <PlayIcon />
          Run now
        </Action>
        <Action tone="outline" data-automation-page-edit onClick={() => editAutomation(project, id)} title="Edit (E)">
          <PencilLineIcon />
          Edit
          <Keys keys={["E"]} />
        </Action>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-6 px-5 pt-3 pb-10">
          {note ? (
            <p data-automation-page-note={note.tone} className={cn("flex items-start gap-2 bg-raised px-3.5 py-2.5 text-ui", note.tone === "caution" ? "text-caution" : note.tone === "negative" ? "text-negative" : "text-muted-foreground")}>
              {note.tone === "faint" ? <CloudIcon aria-hidden className="mt-1 size-3.5 shrink-0" /> : <TriangleAlertIcon aria-hidden className="mt-1 size-3.5 shrink-0" />}
              <span>
                {note.text}
                {view.standing === "paused" && approvedNow(view) ? <span className="text-muted-foreground"> Turning it on again clears this.</span> : null}
              </span>
            </p>
          ) : null}
          {local.enabled && !approvedNow(view) ? (
            <section data-automation-page-changed aria-label="Changed since you approved it" className="flex flex-col gap-3 bg-raised px-4 py-3.5">
              <h2 className="text-ui font-medium text-foreground">{local.approvedDefinition === undefined ? "Not yet approved: it runs nothing until you approve what it says" : "Changed since you approved it: it runs nothing until you approve what it says now"}</h2>
              <AutomationDiff proposal={{ change: "update", ...(local.approvedDefinition !== undefined && { before: local.approvedDefinition }), after: JSON_VALUE.parse(JSON.parse(JSON.stringify(definition))) }} />
              <div>
                <Action tone="outline" data-automation-page-approve onClick={() => void automations.setEnabled(project, id, true, true)}>
                  Approve and turn on
                </Action>
              </div>
            </section>
          ) : null}
          {pending.map((proposal) => (
            <section key={proposal.id} aria-label="Proposed change" className="bg-raised px-4 py-3.5">
              <ProposalBlock proposal={proposal} onDecide={(approve) => automations.decide(proposal.id, approve).then(Boolean)} />
            </section>
          ))}

          <div className="grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Part title="When it runs">
              <ul className="flex flex-col gap-2">
                {definition.triggers.map((trigger, index) => {
                  const Icon = TRIGGER_ICONS[trigger.kind]
                  const waits = triggerWaits(trigger, local.cloudRegistered)
                  return (
                    <li key={index} data-page-trigger={trigger.kind} className="flex min-w-0 items-start gap-2">
                      <Icon aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-ui text-foreground">{triggerWithCondition(trigger)}</span>
                        {waits ? <span className="text-label text-faint">{waits}</span> : null}
                        {trigger.kind === "schedule" ? (
                          <span className="-ml-[22px]">
                            <NextRuns cron={trigger.cron} timezone={trigger.timezone} />
                          </span>
                        ) : null}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Part>
            <Part title="What it starts">
              <Facts facts={[...startFacts(definition.start, harnessLabel), ["Thread", definition.thread === "standing" ? "One standing Thread" : "A new Thread each run"], ["Leaves", RESULT_WORDS[definition.result].label]]} />
            </Part>
            <Part title="What each run does" wide>
              <div className="flex flex-col gap-2 text-ui">
                <p data-page-objective className="leading-relaxed whitespace-pre-wrap text-foreground">{brief.objective}</p>
                {brief.doneWhen?.length ? <List label="Done when" items={brief.doneWhen} /> : null}
                {brief.boundaries?.length ? <List label="Boundaries" items={brief.boundaries} /> : null}
                {brief.output ? (
                  <p className="text-label text-muted-foreground">
                    <span className="text-faint">Its report says </span>
                    {brief.output}
                  </p>
                ) : null}
              </div>
            </Part>
            <Part title="Gate and limits">
              <Facts facts={[...gateFacts, ...limitFacts(definition.limits)]} mono={definition.gate ? ["Gate"] : []} />
            </Part>
            <Part title="Shared and local">
              <p className="text-label leading-relaxed text-muted-foreground">
                Its definition is in <span className="font-mono">{projectName(project)}/.mako/automations.json</span>{localWords(", committed with the repo. Whether it runs is this Mac's alone: a clone never turns it on, and a change to the file after you turned it on pauses it until you turn it on again.")}
              </p>
            </Part>
          </div>

          <Part title="Runs" wide>
            <AutomationRuns project={project} id={id} harness={definition.start.harness} />
          </Part>

          {decided.length ? (
            <Part title="Earlier proposals" wide>
              <div className="flex flex-col gap-2">
                {decided.map((proposal) => (
                  <div key={proposal.id} className="bg-shell/55 px-3.5 py-3 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
                    <ProposalBlock proposal={proposal} onDecide={async () => false} />
                  </div>
                ))}
              </div>
            </Part>
          ) : null}

          <div className="flex items-center gap-1.5">
            <Action tone="ghost" onClick={() => duplicateAutomation(project, id)}>
              <CopyIcon />
              Duplicate
              <Keys keys={["D"]} />
            </Action>
            <Action
              tone="danger"
              data-automation-page-delete
              onClick={() =>
                void automations.remove(project, id).then((removed) => {
                  if (removed) goAutomations({ kind: "list" })
                })
              }
            >
              <Trash2Icon />
              Delete
            </Action>
          </div>
        </div>
      </div>
    </div>
  )
}

function Part({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-2", wide && "lg:col-span-2")}>
      <h2 className="text-label font-medium text-faint">{title}</h2>
      {children}
    </section>
  )
}

function Facts({ facts, mono = [] }: { facts: Array<[string, string]>; mono?: string[] }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-label leading-5 text-faint">{label}</dt>
          <dd className={cn("min-w-0 break-words text-foreground", mono.includes(label) && "font-mono text-label leading-5")}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="text-label">
      <span className="text-faint">{label}</span>
      <ul className="mt-0.5 flex flex-col gap-0.5 text-muted-foreground">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5">
            <span aria-hidden className="text-faint">–</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
