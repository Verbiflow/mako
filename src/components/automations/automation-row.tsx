import { memo, type KeyboardEvent } from "react"
import { z } from "zod"
import { CloudIcon, CopyIcon, MoreHorizontalIcon, PauseIcon, PencilLineIcon, PlayIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
import type { AutomationProposal, AutomationView } from "@mako/host/contracts/automations"
import { ProposalBlock } from "@/components/automations/automation-proposal"
import { TRIGGER_ICONS } from "@/components/automations/trigger-icons"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Keys, Toggle } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { nextRunOf, runAt, standingNote, runStatus, triggersLine, whenAgo, whenAheadIn, localTime, nextRunTitle, type RunTone } from "@/lib/automation-words"
import { cn } from "@/lib/utils"
import { automations, openRunThread } from "@/state/automations"
import { duplicateAutomation, editAutomation, rowKey, showAutomation } from "@/state/automations-view"
import { localWords } from "@mako/protocol/computer-words"

const TONE_TEXT = {
  working: "text-foreground",
  positive: "text-positive",
  negative: "text-negative",
  caution: "text-caution",
  attention: "text-attention",
  faint: "text-faint",
} satisfies Record<RunTone, string>

/**
 * One automation in the list: what it's called and when it runs as a sentence, when it runs next and how it last
 * went, its switch, Run now and its menu. Paused, unsupported, failing or running says so on a line of its own, and a
 * pending proposal for it opens under it, answerable in place. Keys on a focused row: Enter opens it, E edits, R runs
 * it now, T turns it on or off.
 */
export const AutomationRow = memo(function AutomationRow({ view, proposals, now }: { view: AutomationView; proposals: readonly AutomationProposal[]; now: number }) {
  const { definition, local, standing } = view
  const project = view.project
  const key = rowKey(project, definition.id)
  const Icon = TRIGGER_ICONS[definition.triggers.find((trigger) => trigger.kind !== "manual")?.kind ?? "manual"]
  const next = nextRunOf(view, now)
  const last = view.lastRun
  const lastStatus = last ? runStatus(last) : undefined
  const note = standingNote(view)
  const failed = last && (last.status === "failed" || last.status === "failed-to-start")
  const pending = proposals.filter((proposal) => proposal.status === "pending")
  const active = view.activeRun
  const off = !local.enabled
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
    const keyName = event.key.toLowerCase()
    if (event.key === "Enter") showAutomation(project, definition.id)
    else if (keyName === "e") editAutomation(project, definition.id)
    else if (keyName === "r") void automations.runNow(project, definition.id)
    else if (keyName === "t") void automations.setEnabled(project, definition.id, !local.enabled)
    else return
    event.preventDefault()
  }
  return (
    <div data-automation-key={key} data-automation-standing={standing} className="group/automation flex flex-col">
      <div
        role="button"
        tabIndex={0}
        data-automation-row={key}
        aria-label={`${definition.name}: ${triggersLine(definition)}`}
        onClick={() => showAutomation(project, definition.id)}
        onKeyDown={onKey}
        className="pressable flex min-w-0 cursor-default items-start gap-2.5 px-2 py-2 outline-none transition-colors duration-100 hover:bg-fill-hover focus-visible:bg-fill-selected"
      >
        <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center", off ? "text-faint" : "text-muted-foreground")}>
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className={cn("min-w-0 truncate text-ui font-medium", off ? "text-foreground/60" : "text-foreground")}>{definition.name}</span>
            {pending.length ? (
              <span data-automation-pending className="shrink-0 text-label font-medium text-attention">
                {pending.length === 1 ? "Change proposed" : `${pending.length} changes proposed`}
              </span>
            ) : null}
            {standing === "paused" ? (
              <span className="flex shrink-0 items-center gap-1 text-label text-caution">
                <PauseIcon aria-hidden className="size-3" />
                Paused
              </span>
            ) : null}
          </span>
          <span className={cn("truncate text-label", off ? "text-faint" : "text-muted-foreground")}>{triggersLine(definition)}</span>
          {active && active.status === "fired" ? (
            <span className="flex min-w-0 items-center gap-1.5 pt-0.5 text-label text-foreground">
              <LiveMark state="working" size={14} label="Running">
                {definition.start.harness ? <HarnessIcon harness={definition.start.harness} /> : null}
              </LiveMark>
              <span className="truncate">Running since {whenAgo(active.startedAt ?? active.at, now).replace(" ago", "")}</span>
              {active.thread ? (
                <button
                  type="button"
                  data-automation-open-run
                  onClick={(event) => {
                    event.stopPropagation()
                    void openRunThread(active)
                  }}
                  className="pressable shrink-0 px-1 text-label text-muted-foreground underline decoration-hairline underline-offset-2 hover:text-foreground"
                >
                  Open its Thread
                </button>
              ) : null}
            </span>
          ) : null}
          {note ? (
            <span data-automation-note={note.tone} className={cn("flex min-w-0 items-start gap-1.5 pt-0.5 text-label", note.tone === "caution" ? "text-caution" : note.tone === "negative" ? "text-negative" : "text-faint")}>
              {note.tone === "faint" ? <CloudIcon aria-hidden className="mt-0.5 size-3 shrink-0" /> : <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />}
              <span className="line-clamp-2">{note.text}</span>
            </span>
          ) : failed && !note ? (
            <span data-automation-failed className="line-clamp-2 pt-0.5 text-label text-negative/90">{last.why ?? "Its last run failed."}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 pt-px">
          <span className="tabular text-label text-muted-foreground" title={next ? nextRunTitle(next) : undefined} data-automation-next>
            {next ? `Next ${whenAheadIn(next.at, next.zone, now)}` : off ? "Off" : standing === "paused" ? "Paused" : definition.triggers.some((trigger) => trigger.kind !== "manual") ? "On its triggers" : "Run now only"}
          </span>
          {next && localTime(next.at, next.zone) ? (
            <span data-automation-next-local className="tabular text-label text-faint">
              {localTime(next.at, next.zone)}
            </span>
          ) : null}
          {last && lastStatus ? (
            <span className="tabular text-label text-faint" data-automation-last={last.status} title={new Date(runAt(last)).toLocaleString()}>
              <span className={TONE_TEXT[lastStatus.tone]}>{lastStatus.label}</span> {whenAgo(runAt(last), now)}
            </span>
          ) : (
            <span className="text-label text-faint">Never run</span>
          )}
        </span>
        <span className="flex h-5 shrink-0 items-center gap-0.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            data-automation-run-now
            aria-label={`Run ${definition.name} now`}
            title="Run now (R)"
            onClick={() => void automations.runNow(project, definition.id)}
            className="pressable flex size-6 items-center justify-center text-faint opacity-0 transition-opacity duration-100 group-hover/automation:opacity-100 group-focus-within/automation:opacity-100 hover:bg-fill-selected hover:text-foreground focus-visible:opacity-100"
          >
            <PlayIcon className="size-3.5" />
          </button>
          <span className="flex size-7 items-center justify-center" title={off ? localWords("Off on this Mac (T)") : localWords("On on this Mac (T)")}>
            <Toggle label={localWords(`${definition.name} on this Mac`)} on={local.enabled} onChange={() => void automations.setEnabled(project, definition.id, !local.enabled)} />
          </span>
          <RowMenu view={view} />
        </span>
      </div>
      {pending.map((proposal) => (
        <div key={proposal.id} className="mb-2 ml-9 mr-2 bg-raised px-3.5 py-3">
          <ProposalBlock proposal={proposal} compact onDecide={(approve) => automations.decide(proposal.id, approve).then(Boolean)} />
        </div>
      ))}
    </div>
  )
})

function RowMenu({ view }: { view: AutomationView }) {
  const { project } = view
  const { id, name } = view.definition
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button type="button" aria-label={`Actions for ${name}`} data-automation-menu className="pressable flex size-6 items-center justify-center text-faint hover:bg-fill-selected hover:text-foreground data-[state=open]:bg-fill-selected data-[state=open]:text-foreground">
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-48">
        <MenuItem data-automation-action="edit" onSelect={() => editAutomation(project, id)}>
          <PencilLineIcon className="size-3.5" />
          <span className="flex-1">Edit</span>
          <Keys keys={["E"]} />
        </MenuItem>
        <MenuItem data-automation-action="run" onSelect={() => void automations.runNow(project, id)}>
          <PlayIcon className="size-3.5" />
          <span className="flex-1">Run now</span>
          <Keys keys={["R"]} />
        </MenuItem>
        <MenuItem data-automation-action="duplicate" onSelect={() => duplicateAutomation(project, id)}>
          <CopyIcon className="size-3.5" />
          Duplicate
        </MenuItem>
        <MenuSeparator />
        <MenuItem data-automation-action="delete" className="text-negative" onSelect={() => void automations.remove(project, id)}>
          <Trash2Icon className="size-3.5" />
          Delete
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

const NAMED = z.object({ name: z.string() })

/** A proposal to create one that doesn't exist yet: a row of its own, with the proposal open under it. */
export function ProposedRow({ proposal }: { proposal: AutomationProposal }) {
  const named = NAMED.safeParse(proposal.after)
  const name = named.success ? named.data.name : proposal.automation
  return (
    <div data-automation-proposed={proposal.automation} className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2.5 px-2 py-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-attention">
          <span aria-hidden className="size-1.5 rounded-full bg-attention" />
        </span>
        <span className="min-w-0 truncate text-ui font-medium text-foreground">{name}</span>
        <span className="shrink-0 text-label font-medium text-attention">New, proposed</span>
      </div>
      <div className="mb-2 ml-9 mr-2 bg-raised px-3.5 py-3">
        <ProposalBlock proposal={proposal} compact onDecide={(approve) => automations.decide(proposal.id, approve).then(Boolean)} />
      </div>
    </div>
  )
}
