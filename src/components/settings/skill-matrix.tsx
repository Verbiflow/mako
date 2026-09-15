import { useState } from "react"
import { AlertTriangleIcon, GlobeIcon } from "lucide-react"
import { Action, Chip, Eyebrow } from "@/components/ui/kit"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  homeRelative,
  listedCopy,
  skillDirectory,
  type SkillCell,
  type SkillColumn,
  type SkillMatrixRow,
} from "@/lib/skill-matrix"
import type {
  SkillOrigin,
  SkillRecord,
  SkillSyncPreview,
  SkillSyncTarget,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { skills, useSkills } from "@/state/skills"

/**
 * Skills by place. Rows are skills, columns are where a copy can live, and a
 * cell is one quiet dot: filled when that place has the skill, caution-tinted
 * when its copy has drifted from the listed one, an outline when it is
 * absent. Marks live in the header only; forty rows of repeated logos would
 * shout. A cell opens a popover that says what is there, in words, and
 * offers the one or two writes that make sense from that state — each
 * previewed before it happens.
 */

const DOT = {
  installed: "bg-foreground/80",
  drifted: "bg-caution",
  absent: "ring-1 ring-border ring-inset",
} as const

function cellLabel(skill: string, column: SkillColumn, cell: SkillCell): string {
  const where = column.universal ? "the universal skills folder" : column.label
  if (cell.state === "absent") return `${skill} is not in ${where}`
  if (cell.state === "drifted") return `${skill} in ${where} differs from the listed copy`
  return `${skill} is in ${where}`
}

export function SkillMatrix({
  rows,
  columns,
}: {
  rows: SkillMatrixRow[]
  columns: SkillColumn[]
}) {
  const template = `minmax(0,1fr) repeat(${columns.length}, 2.25rem)`
  return (
    <div
      role="grid"
      aria-label="Skills by provider"
      data-skill-matrix
      className="rounded-lg bg-surface ring-1 ring-hairline"
    >
      <div
        role="row"
        className="grid items-center border-b border-hairline px-3 py-2"
        style={{ gridTemplateColumns: template }}
      >
        <Eyebrow role="columnheader" className="px-0">
          Skill
        </Eyebrow>
        {columns.map((column) => (
          <ColumnHeader key={column.id} column={column} />
        ))}
      </div>
      {rows.map((row) => (
        <div
          key={row.skill.id}
          role="row"
          data-skill-row={row.skill.name}
          className={cn(
            "contain-turn grid min-h-11 items-center border-b border-hairline px-3 last:border-b-0",
            !row.skill.portable && "opacity-60"
          )}
          style={{ gridTemplateColumns: template }}
        >
          <div role="gridcell" className="min-w-0 py-2 pr-3">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-ui">{row.skill.name}</span>
              {row.skill.manual ? (
                <Chip className="shrink-0 font-normal">manual</Chip>
              ) : null}
              {row.skill.conflict ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex shrink-0 text-caution" aria-label="Copies differ">
                      <AlertTriangleIcon className="size-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">Copies of this skill differ</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <p className="truncate text-label text-faint">{row.skill.description}</p>
          </div>
          {columns.map((column) => (
            <Cell
              key={column.id}
              skill={row.skill}
              column={column}
              cell={row.cells.get(column.id) ?? { state: "absent", copies: [] }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function ColumnHeader({ column }: { column: SkillColumn }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="columnheader"
          aria-label={column.label}
          data-skill-column={column.id}
          className={cn(
            "inline-flex size-6 items-center justify-center justify-self-center text-muted-foreground",
            !column.available && "opacity-40"
          )}
        >
          {column.universal ? (
            <GlobeIcon className="size-3.5" aria-hidden />
          ) : (
            <HarnessIcon harness={column.id} className="size-3.5" tinted={false} />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {column.universal
          ? "Universal · .agents/skills"
          : column.available
            ? column.label
            : `${column.label} · CLI not found`}
      </TooltipContent>
    </Tooltip>
  )
}

function Cell({
  skill,
  column,
  cell,
}: {
  skill: SkillRecord
  column: SkillColumn
  cell: SkillCell
}) {
  const [open, setOpen] = useState(false)
  const label = cellLabel(skill.name, column, cell)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) skills.clearPreview(skill.id)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="gridcell"
          aria-label={label}
          data-skill-cell={column.id}
          // `data-state` is Radix's (open/closed) and styles the open cell.
          data-cell-state={cell.state}
          className={cn(
            "pressable group/cell inline-flex size-6 items-center justify-center justify-self-center rounded-md",
            "hover:bg-fill-hover data-[state=open]:bg-fill-selected"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "block size-2 rounded-full [transition:transform_120ms_var(--ease-out)]",
              "group-hover/cell:scale-125",
              DOT[cell.state]
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="bottom" className="w-80 overflow-hidden">
        <CellDetail skill={skill} column={column} cell={cell} />
      </PopoverContent>
    </Popover>
  )
}

function CellDetail({
  skill,
  column,
  cell,
}: {
  skill: SkillRecord
  column: SkillColumn
  cell: SkillCell
}) {
  const previews = useSkills((state) => state.previews[skill.id])
  const syncing = useSkills((state) => state.status === "syncing")
  const pending = previews?.find((preview) => preview.target.provider === column.id)
  const listed = listedCopy(skill)
  const target = (scope: SkillSyncTarget["scope"]): SkillSyncTarget => ({
    provider: column.id,
    account: column.account ?? "default",
    scope,
  })

  return (
    <>
      <PopoverHeader>
        <PopoverTitle className="flex items-center gap-2 text-ui">
          <span className="truncate font-mono">{skill.name}</span>
          <span className="text-faint">·</span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            {column.universal ? (
              <GlobeIcon className="size-3.5" aria-hidden />
            ) : (
              <HarnessIcon harness={column.id} className="size-3.5" tinted={false} />
            )}
            {column.label}
          </span>
        </PopoverTitle>
        <PopoverDescription className="text-label">
          {describe(cell, column)}
        </PopoverDescription>
      </PopoverHeader>

      {cell.copies.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {cell.copies.map((copy) => (
            <CopyRow key={copy.provenance} copy={copy} skill={skill} listed={listed} />
          ))}
        </ul>
      ) : null}

      {pending ? (
        <PendingPreview skillId={skill.id} preview={pending} syncing={syncing} />
      ) : column.universal ? null : (
        <div className="flex flex-col items-start gap-1">
          {cell.copies.some((copy) => copy.scope === "user") ? (
            <Action
              tone="outline"
              size="xs"
              disabled={syncing}
              onClick={() => void skills.preview(skill.id, [target("user")], "remove")}
            >
              Remove from all projects…
            </Action>
          ) : (
            <Action
              tone="outline"
              size="xs"
              disabled={syncing || !skill.portable}
              onClick={() => void skills.preview(skill.id, [target("user")], "sync")}
            >
              Install for all projects…
            </Action>
          )}
          {cell.copies.some((copy) => copy.scope === "workspace") ? (
            <Action
              tone="outline"
              size="xs"
              disabled={syncing}
              onClick={() => void skills.preview(skill.id, [target("workspace")], "remove")}
            >
              Remove from this project…
            </Action>
          ) : (
            <Action
              tone="outline"
              size="xs"
              disabled={syncing || !skill.portable}
              onClick={() => void skills.preview(skill.id, [target("workspace")], "sync")}
            >
              Install in this project…
            </Action>
          )}
          {cell.state === "drifted" && listed ? (
            <Action
              tone="outline"
              size="xs"
              disabled={syncing || !skill.portable}
              onClick={() =>
                void skills.preview(
                  skill.id,
                  [target(cell.copies.find((copy) => copy.hash !== skill.hash)?.scope ?? "user")],
                  "sync"
                )
              }
            >
              Match the listed copy…
            </Action>
          ) : null}
        </div>
      )}

      {!skill.portable && skill.blockReason ? (
        <p className="text-label text-faint">
          Cannot be installed: {skill.blockReason}.
        </p>
      ) : null}
      {!column.universal && !column.available ? (
        <p className="text-label text-faint">
          The {column.label} CLI was not found; a copy installed now is read
          once it is.
        </p>
      ) : null}
    </>
  )
}

function describe(cell: SkillCell, column: SkillColumn): string {
  if (column.universal) {
    return cell.state === "absent"
      ? "Not in the universal folder. A copy there reaches every provider through Mako: one verified to read the folder loads it itself, the rest are handed it in the message."
      : "In the universal folder, so every provider reaches it through Mako: one verified to read the folder loads it itself, the rest are handed it in the message."
  }
  if (cell.state === "absent")
    return `Not installed. ${column.label} is handed the instructions inside any message that mentions this skill.`
  if (cell.state === "drifted")
    return `Installed, but this copy differs from the one Mako lists. ${column.label} loads its own copy.`
  return `Installed. ${column.label} loads this skill itself, in Mako and outside it.`
}

function CopyRow({
  copy,
  skill,
  listed,
}: {
  copy: SkillOrigin
  skill: SkillRecord
  listed: SkillOrigin | undefined
}) {
  const drifted = copy.hash !== skill.hash
  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-1.5 text-label">
        <span className="text-muted-foreground">
          {copy.scope === "workspace" ? "This project" : "All projects"}
        </span>
        {drifted ? (
          <span className="inline-flex items-center gap-1 text-caution">
            <AlertTriangleIcon className="size-3" />
            differs
          </span>
        ) : copy === listed ? (
          <span className="text-faint">listed copy</span>
        ) : null}
      </div>
      <p className="truncate font-mono text-label text-faint" title={copy.provenance}>
        {homeRelative(skillDirectory(copy.provenance))}
      </p>
      {drifted && listed ? (
        <p className="text-label text-faint">
          Listed copy: {homeRelative(skillDirectory(listed.provenance))} · hash{" "}
          {listed.hash.slice(0, 8)} vs {copy.hash.slice(0, 8)}
        </p>
      ) : null}
    </li>
  )
}

function PendingPreview({
  skillId,
  preview,
  syncing,
}: {
  skillId: string
  preview: SkillSyncPreview
  syncing: boolean
}) {
  const actionable = preview.action === "add" || preview.action === "replace" || preview.action === "remove"
  return (
    <div className="flex flex-col gap-2 rounded-md bg-raised p-2" data-skill-preview={preview.action}>
      <p className="text-label text-foreground/90">{preview.summary}</p>
      {preview.blockReason ? (
        <p className="text-label text-faint">{preview.blockReason}</p>
      ) : preview.action === "replace" || preview.action === "remove" ? (
        <p className="text-label text-faint">
          The current copy moves into a hidden Mako backup folder beside the
          provider root.
        </p>
      ) : null}
      <div className="flex gap-1.5">
        {actionable ? (
          <Action
            tone="solid"
            size="xs"
            disabled={syncing}
            onClick={() => void skills.apply(skillId)}
          >
            {syncing
              ? "Applying…"
              : preview.action === "remove"
                ? "Remove"
                : preview.action === "replace"
                  ? "Replace"
                  : "Install"}
          </Action>
        ) : null}
        <Action size="xs" disabled={syncing} onClick={() => skills.clearPreview(skillId)}>
          {actionable ? "Cancel" : "Done"}
        </Action>
      </div>
    </div>
  )
}
