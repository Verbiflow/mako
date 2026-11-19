import { useCallback, useEffect, useRef, useState } from "react"
import { FolderOpenIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import type { StorageBudgetSettings, StorageCollection, StoragePart, StorageReport } from "@mako/host/contracts/storage"
import { Action, Chip, IconAction, ListCard, ListCardRow, Meter } from "@/components/ui/kit"
import { IfCanReveal } from "@/components/ui/machine-gate"
import { Shimmer } from "@/components/ui/shimmer"
import { formatBytes, formatRelative } from "@/lib/format"
import { desktop } from "@/state/desktop"
import { freeStorage, planStorage, readStorage, reclaimStorage, setStorageBudget } from "@/state/storage"
import { Biggest, ReclaimClasses, ReclaimHistory } from "./storage-reclaim"
import { StorageRetention } from "./storage-retention"

/** How often the section reads the report while a preview or a removal runs behind it. */
const FOLLOW_MS = 1500

const TRIGGERS = {
  scheduled: "on its schedule",
  person: "when you asked",
  "low disk": "when the disk ran low",
} satisfies Record<StorageCollection["trigger"], string>

function PartRow({ part, largest }: { part: StoragePart; largest: number }) {
  return (
    <ListCardRow className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-ui text-foreground">{part.label}</span>
          {part.collected ? <Chip tone="positive">Collected by Mako</Chip> : null}
        </div>
        {part.detail ? <div className="mt-0.5 text-label text-faint">{part.detail}</div> : null}
        <Meter className="mt-1.5" value={largest ? part.bytes / largest : 0} />
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-label text-muted-foreground tabular-nums">{formatBytes(part.bytes)}</span>
      <IfCanReveal>
        <IconAction label="Show the folder" size="xs" disabled={!part.path} onClick={() => void desktop.revealPath(part.path)}>
          <FolderOpenIcon />
        </IconAction>
      </IfCanReveal>
    </ListCardRow>
  )
}

function collectionLine(collection: StorageCollection, parts: readonly StoragePart[]): string {
  const label = parts.find((part) => part.id === collection.part)?.label ?? collection.part
  const age = formatRelative(collection.at)
  const when = age ? (age === "now" ? "just now" : `${age} ago`) : ""
  if (collection.error) return `${label}: couldn't collect ${when}: ${collection.error}`
  const left = collection.skipped ? `, ${collection.skipped} left for later` : ""
  return `${label}: freed ${formatBytes(collection.freedBytes)} ${when}, ${TRIGGERS[collection.trigger]} (${collection.collected} looked at${left})`
}

/**
 * What Mako keeps on this Mac: the disk, what each store could give back by how expendable it is (with a preview of
 * exactly what goes), the Threads and projects holding most, each folder's size, and how long each store keeps things.
 */
export function StorageSection() {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"measuring" | "freeing" | null>("measuring")
  const follow = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const settle = useCallback((work: Promise<StorageReport>) => work.then(
    (next) => { setReport(next); setError(null) },
    (reason) => setError(reason instanceof Error ? reason.message : String(reason)),
  ).finally(() => setBusy(null)), [])
  useEffect(() => {
    void settle(planStorage())
    void settle(readStorage(true))
  }, [settle])
  // A preview or a removal runs behind its answer: read the report until neither runs.
  useEffect(() => {
    if (!report?.planning && !report?.reclaiming) return undefined
    follow.current = setTimeout(() => void settle(readStorage(false)), FOLLOW_MS)
    return () => clearTimeout(follow.current)
  }, [report, settle])
  const remove = (consent: "now" | "approve", ids: string[]) => void settle(reclaimStorage(consent, ids))
  const budget = (next: StorageBudgetSettings) => void settle(setStorageBudget(next))
  const act = (kind: "measuring" | "freeing", work: () => Promise<StorageReport>) => {
    setBusy(kind)
    void settle(work())
  }

  const disk = report?.disk
  const low = disk ? disk.freeBytes < (report?.lowBytes ?? 0) : false
  const parts = report?.parts ?? []
  const total = parts.reduce((sum, part) => sum + part.bytes, 0)
  const largest = parts[0]?.bytes ?? 0

  return (
    <div className="flex flex-col gap-6" data-storage>
      <section>
        <h3 className="text-ui font-medium">On this Mac</h3>
        <p className="mt-0.5 pb-3 text-label text-muted-foreground">
          What Mako keeps in its folders, and what of it can go. Nothing in use, holding uncommitted or unpushed work,
          or kept on purpose is ever removed.
        </p>

        {disk ? (
          <div className="mb-3 bg-raised px-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="flex-1 text-ui text-foreground">{formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}</span>
              {total ? <span className="text-label text-faint">Mako keeps {formatBytes(total)}</span> : null}
            </div>
            <Meter className="mt-2" tone={low ? "negative" : "neutral"} value={disk.totalBytes ? 1 - disk.freeBytes / disk.totalBytes : 0} />
            {low ? (
              <p className="pt-2 text-label text-negative">
                Under {formatBytes(report?.lowBytes ?? 0)} free. Mako frees what&apos;s safe to remove now and warns about the rest; below, you choose what else goes.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mb-2 flex items-center gap-2">
          <span className="flex-1 text-label text-faint">
            {busy === "measuring" || report?.measuring ? <Shimmer text="Measuring…" /> : report?.at ? `Measured ${formatRelative(report.at) === "now" ? "just now" : `${formatRelative(report.at)} ago`}` : ""}
          </span>
          <Action tone="outline" size="xs" disabled={busy !== null} onClick={() => act("measuring", () => readStorage(true))}>
            <RefreshCwIcon className="size-3" />
            Measure again
          </Action>
          <Action
            tone="outline"
            size="xs"
            disabled={busy !== null || report?.collecting === true}
            title="Removes what Mako's collectors find nothing reads anymore, in stores no session has open"
            onClick={() => act("freeing", freeStorage)}
          >
            <Trash2Icon className="size-3" />
            {busy === "freeing" || report?.collecting ? "Freeing…" : "Free up space"}
          </Action>
        </div>

        {!report && !error ? <p className="text-ui text-faint"><Shimmer text="Measuring Mako's folders…" /></p> : null}
      </section>

      <section>
        <div className="flex items-baseline gap-2 pb-3">
          <h3 className="flex-1 text-ui font-medium">What can go</h3>
          <span className="text-label text-faint">
            {report?.planning ? <Shimmer text="Looking through each Thread's folders…" /> : report?.reclaiming ? <Shimmer text="Removing…" /> : report?.plan ? `Looked ${formatRelative(report.plan.at) === "now" ? "just now" : `${formatRelative(report.plan.at)} ago`}` : ""}
          </span>
          <Action tone="outline" size="xs" disabled={report?.planning === true || report?.reclaiming === true} onClick={() => void settle(planStorage())}>
            <RefreshCwIcon className="size-3" />
            Look again
          </Action>
        </div>
        {report?.plan ? <ReclaimClasses plan={report.plan} busy={report.reclaiming} onRemove={remove} /> : null}
        {report ? <ReclaimHistory reclaims={report.reclaims} /> : null}
      </section>

      {report?.plan ? <Biggest plan={report.plan} /> : null}

      <section>
        <h3 className="pb-3 text-ui font-medium">Folders</h3>
        {parts.length ? (
          <div data-storage-parts>
            <ListCard>
              {parts.map((part) => <PartRow key={`${part.path}:${part.id}`} part={part} largest={largest} />)}
            </ListCard>
          </div>
        ) : null}

        {report?.collections.length ? (
          <div className="flex flex-col gap-1 pt-3" data-storage-collections>
            {report.collections.map((collection) => (
              <p key={`${collection.part}:${collection.at}`} className="text-label text-faint">{collectionLine(collection, parts)}</p>
            ))}
          </div>
        ) : null}

        {error ? <p className="pt-2 text-label text-removed">Mako&apos;s folders couldn&apos;t be measured: {error}</p> : null}
      </section>

      {report ? <StorageRetention budget={report.budget} lowBytes={report.lowBytes} onBudget={budget} /> : null}
    </div>
  )
}
