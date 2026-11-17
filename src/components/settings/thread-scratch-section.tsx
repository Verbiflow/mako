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
    <h3 className="text-ui font-medium">Thread data and scratch</h3>
    <p className="mt-0.5 pb-3 text-label text-muted-foreground">Preview only by default. New Fin data folders can go after their Thread finishes, every ancestor closes or is archived, and nothing uses them. Personal Threads and unknown owners are kept. Disposable scratch can also expire after the idle limit. Shared app state and legacy folders stay. A .keep file retains either root.</p>
    {report ? <ListCard>
      <SettingRow title="Scratch cleanup" description="Removal checks after startup, hourly and on Thread events. Enabling it authorizes removal of eligible registered scratch on the next pass. Preview never removes files.">
        <select aria-label="Scratch cleanup" disabled={busy} value={report.settings.mode} onChange={event => {
          const mode = event.target.value
          if (mode === "preview" || mode === "remove") void save({ ...report.settings, mode })
        }}><option value="preview">Preview only</option><option value="remove">Remove disposable scratch</option></select>
      </SettingRow>
      <SettingRow title="Thread data cleanup" description="Separate opt-in for registered Fin data, including proof and test outputs. An open Apex keeps its tree’s data. Shared app state and legacy roots never qualify. Preview never removes files.">
        <select aria-label="Thread data cleanup" disabled={busy} value={report.settings.dataMode ?? "preview"} onChange={event => {
          const dataMode = event.target.value
          if (dataMode === "preview" || dataMode === "remove") void save({ ...report.settings, dataMode })
        }}><option value="preview">Preview only</option><option value="remove">Remove finished Fins' data</option></select>
      </SettingRow>
      <SettingRow title="Idle days" description="Applies only to disposable scratch. Thread data always needs a finished owner. Unknown or active ownership keeps its files.">
        <input aria-label="Scratch idle days" type="number" min={1} max={3650} value={report.settings.idleDays} disabled={busy} onChange={event => {
          const idleDays = event.target.valueAsNumber
          if (Number.isInteger(idleDays) && idleDays >= 1 && idleDays <= 3650) void save({ ...report.settings, idleDays })
        }} />
      </SettingRow>
      {report.entries.slice(0, 100).map(row => <SettingRow key={`${row.thread}:${row.kind}`} title={`${row.title ?? `Thread ${row.thread}`} · ${row.kind === "data" ? "data" : "scratch"}`} description={`${row.reason} ${row.privateBytes === null ? "Exclusive bytes are not measured on this host." : `${formatBytes(row.privateBytes)} private bytes.`} No files were removed by this preview.`}>
        <Toggle label={`Keep data and scratch for ${row.title ?? row.thread}`} on={report.settings.kept.includes(row.thread)} onChange={() => void save({ ...report.settings, kept: report.settings.kept.includes(row.thread) ? report.settings.kept.filter(thread => thread !== row.thread) : [...report.settings.kept, row.thread] })} />
      </SettingRow>)}
      {!report.entries.length ? <p className="text-label text-faint">No registered roots yet. Existing Thread and app data stay in place.</p> : null}
      {report.entries.length > 100 ? <p className="text-label text-faint">Showing 100 of {report.entries.length} registered folders.</p> : null}
      <Action tone="outline" size="xs" disabled={busy} onClick={() => void read()}>Preview scratch</Action>
    </ListCard> : null}
    {error ? <p className="pt-2 text-label text-removed">{error}</p> : null}
  </section>
}
