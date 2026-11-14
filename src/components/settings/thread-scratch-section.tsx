import { useCallback, useEffect, useState } from "react"
import type { ThreadScratchReport, ThreadScratchSettings } from "@mako/host/contracts/thread-scratch"
import { Action, ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { formatBytes } from "@/lib/format"
import { readThreadScratch, saveThreadScratch } from "@/state/worktrees"

export function ThreadScratchSection() {
  const [report, setReport] = useState<ThreadScratchReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const read = useCallback(() => readThreadScratch().then(setReport, reason => setError(reason instanceof Error ? reason.message : String(reason))), [])
  useEffect(() => { void read() }, [read])
  const save = async (settings: ThreadScratchSettings) => {
    setBusy(true)
    try { setReport(await saveThreadScratch(settings)); setError(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section>
    <h3 className="text-ui font-medium">Disposable Thread scratch</h3>
    <p className="mt-0.5 pb-3 text-label text-muted-foreground">Preview only by default. Registered clones, benchmark worlds and packaging scratch can go after their Thread ends or seven idle days, when no provider, terminal or process uses them. Ordinary Thread data and unregistered folders stay. A .keep file in a scratch root keeps it.</p>
    {report ? <ListCard>
      <SettingRow title="Scratch cleanup" description="Removal checks hourly and on Thread events. Enabling it authorizes removal of eligible registered scratch on the next pass. Preview never removes files.">
        <select aria-label="Scratch cleanup" disabled={busy} value={report.settings.mode} onChange={event => {
          const mode = event.target.value
          if (mode === "preview" || mode === "remove") void save({ ...report.settings, mode })
        }}><option value="preview">Preview only</option><option value="remove">Remove disposable scratch</option></select>
      </SettingRow>
      <SettingRow title="Idle days" description="An ended Thread does not need this wait. Unknown or active ownership always keeps its files.">
        <input aria-label="Scratch idle days" type="number" min={1} max={3650} value={report.settings.idleDays} disabled={busy} onChange={event => {
          const idleDays = event.target.valueAsNumber
          if (Number.isInteger(idleDays) && idleDays >= 1 && idleDays <= 3650) void save({ ...report.settings, idleDays })
        }} />
      </SettingRow>
      {report.entries.slice(0, 100).map(row => <SettingRow key={row.thread} title={row.title ?? `Thread ${row.thread}`} description={`${row.reason} ${row.privateBytes === null ? "Exclusive bytes are not measured on this host." : `${formatBytes(row.privateBytes)} private bytes.`} No files were removed by this preview.`}>
        <Toggle label={`Keep scratch for ${row.title ?? row.thread}`} on={report.settings.kept.includes(row.thread)} onChange={() => void save({ ...report.settings, kept: report.settings.kept.includes(row.thread) ? report.settings.kept.filter(thread => thread !== row.thread) : [...report.settings.kept, row.thread] })} />
      </SettingRow>)}
      {!report.entries.length ? <p className="text-label text-faint">No registered scratch yet. Existing Thread data is kept.</p> : null}
      {report.entries.length > 100 ? <p className="text-label text-faint">Showing 100 of {report.entries.length} registered folders.</p> : null}
      <Action tone="outline" size="xs" disabled={busy} onClick={() => void read()}>Preview scratch</Action>
    </ListCard> : null}
    {error ? <p className="pt-2 text-label text-removed">{error}</p> : null}
  </section>
}
