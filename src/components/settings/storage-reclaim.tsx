import { useMemo, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, FolderOpenIcon, Trash2Icon } from "lucide-react"
import type { ReclaimClass, ReclaimItem, ReclaimOutcome, ReclaimPlan, ReclaimStore } from "@mako/host/contracts/storage"
import { Action, Check, Chip, IconAction, ListCard, ListCardRow, Meter } from "@/components/ui/kit"
import { IfCanReveal } from "@/components/ui/machine-gate"
import { formatBytes, formatRelative } from "@/lib/format"
import { desktop } from "@/state/desktop"

/** How many rows a class's preview draws; the rest are counted. */
const SHOWN_ITEMS = 150

const STORES = {
  scratch: "Scratch",
  "thread-data": "Thread data",
  "app-data": "Old data folder",
  worktrees: "Worktree",
  snapshots: "Rewind",
} satisfies Record<ReclaimStore, string>

const CLASSES = {
  now: {
    title: "Safe to remove now",
    body: "Archived or finished Threads' scratch, data and worktrees, and old rewind checkpoints. Nothing uses them, and they hold no uncommitted or unpushed work. Mako removes these by itself when the disk runs low.",
  },
  approve: {
    title: "Needs your OK",
    body: "Nothing uses these either, but they belong to Threads you haven't archived, to Threads this Mac no longer lists, or to a project's app data every Thread there shares.",
  },
  keep: {
    title: "Kept",
    body: "In use, holding uncommitted or unpushed work, written in the last two days, or kept on purpose.",
  },
} satisfies Record<ReclaimClass, { title: string; body: string }>

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const sum = (items: readonly ReclaimItem[]) => items.reduce((total, item) => total + (item.bytes ?? 0), 0)
const ago = (at: string | number) => {
  const age = formatRelative(at)
  // A recent time reads as an age ("2d"), an older one as its date ("Nov 4").
  return age === "now" ? "just now" : /^\d/.test(age) ? `${age} ago` : age ? `on ${age}` : ""
}

function ItemRow({ item, checked, onCheck }: { item: ReclaimItem; checked?: boolean; onCheck?: () => void }) {
  const used = item.usedAt ? ago(item.usedAt) : ""
  return (
    <ListCardRow className="flex items-center gap-3" data-reclaim-item={item.class}>
      {onCheck ? <Check label={`Remove ${item.label}`} checked={checked === true} onChange={onCheck} /> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-ui text-foreground">{item.label}</span>
          <Chip>{STORES[item.store]}</Chip>
        </div>
        <div className="mt-0.5 truncate text-label text-faint">
          {[item.project, used && `used ${used}`, item.reason].filter(Boolean).join(" · ")}
        </div>
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-label text-muted-foreground tabular-nums">{item.bytes === null ? "…" : formatBytes(item.bytes)}</span>
      <IfCanReveal>
        <IconAction label="Show the folder" size="xs" onClick={() => void desktop.revealPath(item.path)}>
          <FolderOpenIcon />
        </IconAction>
      </IfCanReveal>
    </ListCardRow>
  )
}

/**
 * One class of what Mako keeps: its total, and a preview of exactly what would go. Removing asks once more with the
 * count and size in the button, and the host looks at each folder again before it goes.
 */
function ClassCard({ kind, items, busy, open, onOpen, onRemove }: {
  kind: ReclaimClass
  items: readonly ReclaimItem[]
  busy: boolean
  open: boolean
  onOpen: () => void
  onRemove?: (ids: string[]) => void
}) {
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const chosen = items.filter((item) => !unchecked.has(item.id))
  const bytes = sum(kind === "keep" ? items : chosen)
  const text = CLASSES[kind]
  const toggle = (id: string) => {
    setConfirming(false)
    setUnchecked((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <div data-reclaim-class={kind}>
      <ListCard>
        <ListCardRow className="flex items-start gap-3">
          <button type="button" className="pressable mt-0.5 text-faint" aria-label={open ? `Hide ${text.title}` : `Preview ${text.title}`} onClick={onOpen} disabled={!items.length}>
            {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-ui font-medium text-foreground">{text.title}</span>
              <span className="text-label text-faint">{items.length ? plural(items.length, "folder") : "Nothing"}</span>
            </div>
            <p className="mt-0.5 max-w-[34rem] text-label leading-relaxed text-muted-foreground">{text.body}</p>
          </div>
          <span className="shrink-0 font-mono text-ui text-foreground tabular-nums">{formatBytes(sum(items))}</span>
        </ListCardRow>
        {open ? items.slice(0, SHOWN_ITEMS).map((item) => (
          <ItemRow key={item.id} item={item} {...kind === "approve" && { checked: !unchecked.has(item.id), onCheck: () => toggle(item.id) }} />
        )) : null}
        {open && items.length > SHOWN_ITEMS ? <ListCardRow className="text-label text-faint">And {plural(items.length - SHOWN_ITEMS, "smaller folder")}.</ListCardRow> : null}
        {open && onRemove && chosen.length ? (
          <ListCardRow className="flex items-center gap-2">
            <span className="flex-1 text-label text-faint">
              {confirming ? "Each folder is looked at again first; anything in use or holding work by then stays." : "Branches and conversations stay; a worktree comes back with its Thread's next message."}
            </span>
            {confirming ? <Action tone="outline" size="xs" onClick={() => setConfirming(false)}>Cancel</Action> : null}
            <Action
              tone="outline"
              size="xs"
              disabled={busy}
              className={confirming ? "text-negative" : undefined}
              onClick={() => {
                if (confirming) onRemove(chosen.map((item) => item.id))
                setConfirming(!confirming)
              }}
            >
              <Trash2Icon className="size-3" />
              {confirming ? `Remove ${plural(chosen.length, "folder")} (${formatBytes(bytes)})` : `Remove ${formatBytes(bytes)}`}
            </Action>
          </ListCardRow>
        ) : null}
      </ListCard>
    </div>
  )
}

export function ReclaimClasses({ plan, busy, onRemove }: { plan: ReclaimPlan; busy: boolean; onRemove: (consent: "now" | "approve", ids: string[]) => void }) {
  const [open, setOpen] = useState<ReclaimClass | null>(null)
  const by = (kind: ReclaimClass) => plan.items.filter((item) => item.class === kind)
  return (
    <div className="flex flex-col gap-2" data-reclaim-classes>
      {(["now", "approve", "keep"] as const).map((kind) => (
        <ClassCard
          key={kind}
          kind={kind}
          items={by(kind)}
          busy={busy}
          open={open === kind}
          onOpen={() => setOpen(open === kind ? null : kind)}
          {...kind !== "keep" && { onRemove: (ids: string[]) => onRemove(kind, ids) }}
        />
      ))}
    </div>
  )
}

function Ranking({ title, rows }: { title: string; rows: Array<{ key: string; label: string; bytes: number; detail: string }> }) {
  const largest = rows[0]?.bytes ?? 0
  return (
    <div className="min-w-0 flex-1">
      <h4 className="pb-1.5 text-label font-medium text-muted-foreground">{title}</h4>
      <ListCard>
        {rows.map((row) => (
          <ListCardRow key={row.key} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-ui text-foreground">{row.label}</div>
              <div className="truncate text-label text-faint">{row.detail}</div>
              <Meter className="mt-1.5" value={largest ? row.bytes / largest : 0} />
            </div>
            <span className="w-16 shrink-0 text-right font-mono text-label text-muted-foreground tabular-nums">{formatBytes(row.bytes)}</span>
          </ListCardRow>
        ))}
      </ListCard>
    </div>
  )
}

/** The Threads and projects holding the most, over every store, whatever their class. */
export function Biggest({ plan }: { plan: ReclaimPlan }) {
  const [threads, projects] = useMemo(() => {
    const rank = (key: (item: ReclaimItem) => string | undefined, label: (item: ReclaimItem) => string) => {
      const groups = new Map<string, { key: string; label: string; bytes: number; stores: Set<string> }>()
      for (const item of plan.items) {
        const id = key(item)
        if (!id) continue
        const group = groups.get(id) ?? { key: id, label: label(item), bytes: 0, stores: new Set<string>() }
        group.bytes += item.bytes ?? 0
        group.stores.add(STORES[item.store].toLowerCase())
        groups.set(id, group)
      }
      return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 6).map((group) => ({ ...group, detail: [...group.stores].join(", ") }))
    }
    return [rank((item) => item.thread, (item) => item.label), rank((item) => item.project, (item) => item.project ?? "")]
  }, [plan])
  if (!threads.length && !projects.length) return null
  return (
    <div className="flex gap-3" data-storage-biggest>
      {threads.length ? <Ranking title="Biggest Threads" rows={threads} /> : null}
      {projects.length ? <Ranking title="Biggest projects" rows={projects} /> : null}
    </div>
  )
}

const TRIGGERS = { person: "when you asked", "low disk": "when the disk ran low" } satisfies Record<ReclaimOutcome["trigger"], string>

/** "Freed 41.2 GB when you asked, just now: 12 folders removed, 1 kept (in use)." */
function reclaimLine(outcome: ReclaimOutcome): string {
  const kept = outcome.kept.length ? `, ${plural(outcome.kept.length, "folder")} kept (${outcome.kept[0]!.reason.replace(/\.$/, "").toLowerCase()})` : ""
  return `Freed ${formatBytes(outcome.freedBytes)} ${TRIGGERS[outcome.trigger]}, ${ago(outcome.at)}: ${plural(outcome.removed.length, "folder")} removed${kept}.`
}

/** The latest removals, the person's and the low-disk pass's, newest first. */
export function ReclaimHistory({ reclaims }: { reclaims: readonly ReclaimOutcome[] }) {
  if (!reclaims.length) return null
  return (
    <div className="flex flex-col gap-1 pt-3" data-storage-reclaims>
      {reclaims.map((outcome) => <p key={`${outcome.trigger}:${outcome.at}`} className="text-label text-faint">{reclaimLine(outcome)}</p>)}
    </div>
  )
}
