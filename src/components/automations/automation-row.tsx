import { memo } from "react"
import { z } from "zod"
import { CheckIcon, CopyIcon, MoreHorizontalIcon, PencilLineIcon, PlayIcon, PowerIcon, Trash2Icon } from "lucide-react"
import type { AutomationProposal, AutomationView } from "@mako/host/contracts/automations"
import { ProposalBlock } from "@/components/automations/automation-proposal"
import { TRIGGER_ICONS } from "@/components/automations/trigger-icons"
import { Action, IconAction, Keys } from "@/components/ui/kit"
import { ListRow, ROW_META, RowEnd } from "@/components/ui/list"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { automationFix, type AutomationFix } from "@/lib/automation-fix"
import { nextRunOf, nextRunTitle, projectName, runAt, runStatus, shortTriggers, standingNote, triggersLine, whenAgo, whenAheadIn, PROPOSAL_CHANGE_WORDS, type RunTone } from "@/lib/automation-words"
import { cn } from "@/lib/utils"
import { automations } from "@/state/automations"
import { duplicateAutomation, editAutomation, rowKey, showAutomation } from "@/state/automations-view"
import { localWords } from "@mako/protocol/computer-words"

const DOT = {
  working: "bg-foreground/40",
  positive: "bg-positive",
  negative: "bg-negative",
  caution: "bg-caution",
  attention: "bg-attention",
  faint: "bg-foreground/25",
} satisfies Record<RunTone, string>

const FIX_TONE = { negative: "text-negative", attention: "text-attention", caution: "text-caution" } satisfies Record<AutomationFix["tone"], string>

interface NextWords {
  text: string
  /** The time in full, or what it waits on. */
  title?: string
}

/** Its next run in few words, or what it waits on instead. */
function nextWords(view: AutomationView, now: number): NextWords {
  const next = nextRunOf(view, now)
  if (next) return { text: whenAheadIn(next.at, next.zone, now), title: nextRunTitle(next) }
  if (view.standing === "off") return { text: "Off" }
  if (view.standing === "paused") return { text: "Paused" }
  return { text: "—", title: view.definition.triggers.some((trigger) => trigger.kind !== "manual") ? "On its triggers" : "Run now only" }
}

/** The line under a row that needs the person: why, and the one action that fixes it. */
function FixLine({ fix }: { fix: AutomationFix }) {
  return (
    <span data-automation-fix={fix.tone} className="flex w-full min-w-0 items-center gap-2 pl-6.5">
      <span className={cn("min-w-0 flex-1 truncate text-label", FIX_TONE[fix.tone])} title={fix.text}>
        {fix.text}
      </span>
      <Action
        size="xs"
        tone="quiet"
        data-automation-fix-action={fix.action.kind}
        onClick={(event) => {
          event.stopPropagation()
          fix.action.run()
        }}
        className="text-label"
      >
        {fix.action.label}
      </Action>
    </span>
  )
}

/**
 * One automation, on one line: its trigger's mark, its name, its project (when there are several), when it runs in
 * few words, its next run, and its last run's dot and age, which Run now and its menu take over under the pointer or
 * the keyboard. One that needs the person says why on a second line, with the one action that fixes it; selected,
 * a pending proposal opens under it, answerable in place. Keys on the selected row (`automations-view.tsx`): Enter
 * opens it, E edits, R runs it now, T turns it on or off, Delete deletes it.
 */
export const AutomationRow = memo(function AutomationRow({ view, proposals, now, selected, reviewing, checked = false, showProject, onSelect, onReview }: { view: AutomationView; proposals: readonly AutomationProposal[]; now: number; selected: boolean; reviewing: boolean; checked?: boolean; showProject: boolean; onSelect: (key: string) => void; onReview: (key: string) => void }) {
  const { definition, local, standing, project } = view
  const key = rowKey(project, definition.id)
  const Icon = TRIGGER_ICONS[definition.triggers.find((trigger) => trigger.kind !== "manual")?.kind ?? "manual"]
  const last = view.lastRun
  const lastStatus = last ? runStatus(last) : undefined
  const running = view.activeRun?.status === "fired"
  const off = !local.enabled
  const pending = proposals.filter((proposal) => proposal.status === "pending")
  const fix = automationFix(view, proposals, () => onReview(key))
  const next = nextWords(view, now)
  const note = standingNote(view)
  return (
    <div data-automation-key={key} data-automation-standing={running ? "running" : standing} className="flex flex-col">
      <ListRow
        rowKey={key}
        selected={selected}
        data-automation-row={key}
        aria-label={`${definition.name}: ${triggersLine(definition)}`}
        onClick={() => {
          onSelect(key)
          showAutomation(project, definition.id)
        }}
        className={cn(fix && "h-auto flex-wrap gap-y-0.5 py-2")}
      >
        <span data-automation-checked={checked || undefined} className={cn("flex size-4 shrink-0 items-center justify-center", checked ? "bg-foreground text-background" : off ? "text-faint" : "text-muted-foreground")}>
          {checked ? <CheckIcon aria-label="Checked" className="size-3" strokeWidth={3} /> : <Icon aria-hidden className="size-3.5" />}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-ui font-medium", off ? "text-foreground/60" : "text-foreground")}>{definition.name}</span>
        {showProject ? (
          <span className={cn(ROW_META, "hidden max-w-32 shrink-0 @xl/list:block")} title={project}>
            {projectName(project)}
          </span>
        ) : null}
        <span className={cn(ROW_META, "hidden w-32 shrink-0 @lg/list:block")} title={note ? `${triggersLine(definition)}. ${note.text}` : triggersLine(definition)} data-automation-when>
          {shortTriggers(definition)}
        </span>
        <span className="tabular w-24 shrink-0 truncate text-right text-label text-muted-foreground" title={next.title} data-automation-next>
          {next.text}
        </span>
        <RowEnd
          className="w-20"
          age={
            running ? (
              <span className="flex items-center gap-1.5 text-label text-foreground" data-automation-last="fired">
                <span aria-hidden className={cn("size-1.5 rounded-full", DOT.working)} />
                Running
              </span>
            ) : last && lastStatus ? (
              <span className="tabular flex items-center gap-1.5 text-label text-faint" data-automation-last={last.status} title={`${lastStatus.label} · ${new Date(runAt(last)).toLocaleString()}`}>
                <span aria-hidden className={cn("size-1.5 rounded-full", DOT[lastStatus.tone])} />
                {whenAgo(runAt(last), now).replace(" ago", "").replace("just now", "now")}
              </span>
            ) : (
              <span className="text-label text-faint">Never run</span>
            )
          }
          actions={
            <>
              <IconAction size="xs" label="Run now" keys={["R"]} data-automation-run-now onClick={() => void automations.runNow(project, definition.id)}>
                <PlayIcon />
              </IconAction>
              <RowMenu view={view} />
            </>
          }
        />
        {fix ? <FixLine fix={fix} /> : null}
      </ListRow>
      {reviewing
        ? pending.map((proposal) => (
            <div key={proposal.id} className="pt-1 pr-2 pb-3 pl-8.5">
              <ProposalBlock proposal={proposal} compact onDecide={(approve) => automations.decide(proposal.id, approve).then(Boolean)} />
            </div>
          ))
        : null}
    </div>
  )
})

function RowMenu({ view }: { view: AutomationView }) {
  const { project } = view
  const { id, name } = view.definition
  const on = view.local.enabled
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
        <MenuItem data-automation-action="toggle" onSelect={() => void automations.setEnabled(project, id, !on)}>
          <PowerIcon className="size-3.5" />
          <span className="flex-1">{on ? localWords("Turn off on this Mac") : localWords("Turn on on this Mac")}</span>
          <Keys keys={["T"]} />
        </MenuItem>
        <MenuItem data-automation-action="duplicate" onSelect={() => duplicateAutomation(project, id)}>
          <CopyIcon className="size-3.5" />
          Duplicate
        </MenuItem>
        <MenuSeparator />
        <MenuItem data-automation-action="delete" className="text-negative" onSelect={() => void automations.remove(project, id)}>
          <Trash2Icon className="size-3.5" />
          <span className="flex-1">Delete</span>
          <Keys keys={["⌫"]} />
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

const NAMED = z.object({ name: z.string() })

/** A proposal to create one that doesn't exist yet: a row of its own; selected, the proposal opens under it. */
export function ProposedRow({ proposal, selected, reviewing, onSelect, onReview }: { proposal: AutomationProposal; selected: boolean; reviewing: boolean; onSelect: (key: string) => void; onReview: (key: string) => void }) {
  const named = NAMED.safeParse(proposal.after)
  const name = named.success ? named.data.name : proposal.automation
  const key = `proposed:${proposal.id}`
  return (
    <div data-automation-proposed={proposal.automation} className="flex flex-col">
      <ListRow rowKey={key} selected={selected} onClick={() => onSelect(key)} className="h-auto flex-wrap gap-y-0.5 py-2">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <span aria-hidden className="size-1.5 rounded-full bg-attention" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{name}</span>
        <span className="shrink-0 text-label text-faint">New</span>
        <FixLine fix={{ text: PROPOSAL_CHANGE_WORDS.create, tone: "attention", action: { kind: "review", label: "Review proposal", run: () => onReview(key) } }} />
      </ListRow>
      {reviewing ? (
        <div className="pt-1 pr-2 pb-3 pl-8.5">
          <ProposalBlock proposal={proposal} compact onDecide={(approve) => automations.decide(proposal.id, approve).then(Boolean)} />
        </div>
      ) : null}
    </div>
  )
}
