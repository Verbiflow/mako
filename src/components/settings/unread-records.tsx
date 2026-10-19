import { useMemo } from "react"
import type { UnreadReport, UnreadRow } from "@mako/host/contracts/unread-records"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ShowOriginal } from "@/components/transcript/show-original"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { formatRelative } from "@/lib/format"
import { unreadSummary, unreadRowWords } from "@/lib/unread-records"
import type { MessageOrigin } from "@/lib/types"

/**
 * Records Mako couldn't read, by harness and the version that wrote them:
 * what a harness release adds before Mako's readers learn it. Saved ones
 * come from every session decoded, each under the version its records say
 * wrote it; live ones from this host's own launches. Each row opens the
 * newest one's bytes, as Show original does in a transcript. Counts only:
 * nothing of a record shows until it's opened.
 */
export function UnreadRecords({ report }: { report: UnreadReport | null }) {
  useHarnessIdentity()
  const harnesses = useMemo(() => {
    const byHarness = new Map<string, UnreadRow[]>()
    for (const row of report?.rows ?? []) byHarness.set(row.harness, [...(byHarness.get(row.harness) ?? []), row])
    return [...byHarness]
  }, [report])
  if (!report) return null
  return (
    <div data-unread-records className="mt-2 rounded-lg bg-surface ring-1 ring-hairline">
      <div className="px-3 py-2">
        <p className="text-ui">Unread records</p>
        <p className="text-label leading-relaxed text-faint">{unreadSummary(report)}</p>
      </div>
      {harnesses.length ? (
        <div className="border-t border-hairline">
          {harnesses.map(([harness, rows]) => (
            <div key={harness} data-unread-harness={harness} className="border-b border-hairline px-3 py-1.5 last:border-b-0">
              <div className="flex items-center gap-1.5 pb-0.5 text-label text-muted-foreground">
                <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
                <span>{harnessLabel(harness)}</span>
              </div>
              {rows.map((row) => (
                <UnreadRowLine key={`${row.from}\0${row.version ?? ""}\0${row.kind}\0${row.reason}`} row={row} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function UnreadRowLine({ row }: { row: UnreadRow }) {
  const words = unreadRowWords(row)
  const origins = useMemo((): MessageOrigin[] => {
    const example = row.example
    if (example.kind === "entry") return [{ path: example.path, entries: [{ id: example.id, type: "unread", label: row.kind, ...example.record && { record: example.record } }] }]
    if (example.kind === "stream") return [{ entries: [{ type: "unread", label: row.kind, stream: example.frame }] }]
    return []
  }, [row])
  return (
    <div data-unread-row={row.from} className="flex min-w-0 items-center gap-3 py-0.5 text-label">
      <span className="tabular w-28 shrink-0 truncate text-muted-foreground" title={words.versionDetail}>
        {words.version}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={row.kind}>
        {row.kind}
      </span>
      <span className="shrink-0 text-faint">
        {words.counts}
        {row.newestAt ? ` · ${formatRelative(row.newestAt)}` : ""}
      </span>
      <ShowOriginal origins={origins} className="shrink-0 text-faint" />
    </div>
  )
}
