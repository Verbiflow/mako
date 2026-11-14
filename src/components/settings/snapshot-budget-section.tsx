import { useCallback, useEffect, useState } from "react"
import type { SnapshotBudgetReport, SnapshotBudgetSettings } from "@mako/host/contracts/snapshot-budget"
import { Action, ListCard, SettingRow } from "@/components/ui/kit"
import { formatBytes } from "@/lib/format"
import { readSnapshotBudget, saveSnapshotBudget } from "@/state/worktrees"

export function SnapshotBudgetSection() {
  const [report, setReport] = useState<SnapshotBudgetReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const read = useCallback(() => readSnapshotBudget().then(setReport, reason => setError(reason instanceof Error ? reason.message : String(reason))), [])
  useEffect(() => { void read() }, [read])
  const save = async (settings: SnapshotBudgetSettings) => {
    setBusy(true)
    try { setReport(await saveSnapshotBudget(settings)); setError(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section>
    <h3 className="text-ui font-medium">Rewind storage across conversations</h3>
    <p className="mt-0.5 pb-3 text-label text-muted-foreground">One budget across repositories and conversations on this host profile. Preview only by default, with an 8 GiB payload limit. Enabled eviction takes the oldest proven settled turns first. Running or uncertain work, previews, unfinished restores and unproven checkpoints stay. An evicted checkpoint can no longer rewind files.</p>
    {report ? <ListCard>
      <SettingRow title="Rewind budget" description="Enabling eviction authorizes the next hourly or settled-turn pass. Captures stop at the limit if protected data leaves no room. Up to 64 checkpoints go per pass; more eligible data continues in the background. No conversation messages are removed.">
        <select aria-label="Rewind budget" value={report.settings.mode} disabled={busy} onChange={event => {
          const mode = event.target.value
          if (mode === "preview" || mode === "evict") void save({ ...report.settings, mode })
        }}><option value="preview">Preview only</option><option value="evict">Evict oldest settled checkpoints</option></select>
      </SettingRow>
      <SettingRow title="Total payload GiB" description="File payload bytes, including untracked retained payload; filesystem blocks and APFS private bytes differ. Protected data can remain above this limit.">
        <input aria-label="Total rewind payload GiB" type="number" min={1} max={1024} value={report.settings.maxBytes / 1024 ** 3} disabled={busy} onChange={event => {
          const gib = event.target.valueAsNumber
          if (Number.isInteger(gib) && gib >= 1 && gib <= 1024) void save({ ...report.settings, maxBytes: gib * 1024 ** 3 })
        }} />
      </SettingRow>
      <p className="text-label text-muted-foreground">{formatBytes(report.payloadBytes)} payload; {formatBytes(report.selectedBytes)} selected by this preview. {formatBytes(report.untrackedBytes)} is untracked and held. No files were removed by this preview.</p>
      {report.entries.filter(row => !row.eligible || row.selected).slice(0, 50).map(row => <SettingRow key={row.id} title={`Checkpoint ${row.id.slice(0, 8)}`} description={`${row.reason} ${formatBytes(row.bytes)} payload.`} />)}
      <Action tone="outline" size="xs" disabled={busy} onClick={() => void read()}>Preview rewind storage</Action>
    </ListCard> : null}
    {error ? <p className="pt-2 text-label text-removed">{error}</p> : null}
  </section>
}
