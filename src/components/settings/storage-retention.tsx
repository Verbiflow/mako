import { useCallback, useEffect, useState } from "react"
import type { SnapshotBudgetSettings } from "@mako/host/contracts/snapshot-budget"
import type { StorageBudgetSettings } from "@mako/host/contracts/storage"
import type { ThreadScratchSettings } from "@mako/host/contracts/thread-scratch"
import type { WorktreeRetentionSettings } from "@mako/host/contracts/thread-worktrees"
import { Field, ListCard, Select, SettingRow, Toggle } from "@/components/ui/kit"
import { formatBytes } from "@/lib/format"
import { readSnapshotBudget, readThreadScratch, readWorktreeRetention, saveSnapshotBudget, saveThreadScratch, saveWorktreeRetention } from "@/state/worktrees"

interface Settings {
  scratch: ThreadScratchSettings | null
  worktrees: WorktreeRetentionSettings | null
  rewind: SnapshotBudgetSettings | null
}

const whole = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max

/** How long each store keeps what it holds, and whether Mako frees space by itself when the disk runs low. */
export function StorageRetention({ budget, lowBytes, onBudget }: { budget: StorageBudgetSettings; lowBytes: number; onBudget: (next: StorageBudgetSettings) => void }) {
  const [settings, setSettings] = useState<Settings>({ scratch: null, worktrees: null, rewind: null })
  const [error, setError] = useState<string | null>(null)
  const failed = (reason: Error) => setError(reason.message)
  const read = useCallback(() => {
    // Each store answers for itself: one unavailable here leaves the others' settings shown.
    void readThreadScratch().then((report) => setSettings((previous) => ({ ...previous, scratch: report.settings })), failed)
    void readWorktreeRetention().then((report) => setSettings((previous) => ({ ...previous, worktrees: report.settings })), failed)
    void readSnapshotBudget().then((report) => setSettings((previous) => ({ ...previous, rewind: report.settings })), failed)
  }, [])
  useEffect(read, [read])
  const saveScratch = (scratch: ThreadScratchSettings) => void saveThreadScratch(scratch).then((report) => setSettings((previous) => ({ ...previous, scratch: report.settings })), failed)
  const saveWorktrees = (worktrees: WorktreeRetentionSettings) => void saveWorktreeRetention(worktrees).then((report) => setSettings((previous) => ({ ...previous, worktrees: report.settings })), failed)
  const saveRewind = (rewind: SnapshotBudgetSettings) => void saveSnapshotBudget(rewind).then((report) => setSettings((previous) => ({ ...previous, rewind: report.settings })), failed)
  const { scratch, worktrees, rewind } = settings

  return (
    <section data-storage-retention>
      <h3 className="text-ui font-medium">How long Mako keeps things</h3>
      <p className="mt-0.5 pb-3 text-label text-muted-foreground">
        Nothing in use, holding uncommitted or unpushed work, or with a .keep file in it is ever removed.
      </p>
      <ListCard>
        <SettingRow
          title="Free space when the disk runs low"
          description={`Under ${formatBytes(lowBytes)} free, Mako removes what's safe to remove now, oldest first, and tells you what went.`}
        >
          <Toggle label="Free space when the disk runs low" on={budget.autoFree} onChange={() => onBudget({ autoFree: !budget.autoFree })} />
        </SettingRow>
        {scratch ? (
          <SettingRow
            title="Thread scratch"
            description="Clones, builds and benchmarks agents make. A Fin's goes once it finishes, an archived Thread's at once, any other Thread's after these quiet days."
          >
            <div className="flex items-center gap-2">
              <Select aria-label="Thread scratch" value={scratch.mode} onChange={(event) => {
                const mode = event.target.value
                if (mode === "preview" || mode === "remove") saveScratch({ ...scratch, mode })
              }}>
                <option value="remove">Remove</option>
                <option value="preview">Keep</option>
              </Select>
              <Field aria-label="Quiet days before scratch goes" className="w-14" type="number" min={1} max={3650} value={scratch.idleDays} onChange={(event) => {
                const idleDays = event.target.valueAsNumber
                if (whole(idleDays, 1, 3650)) saveScratch({ ...scratch, idleDays })
              }} />
              <span className="text-label text-faint">days</span>
            </div>
          </SettingRow>
        ) : null}
        {scratch ? (
          <SettingRow
            title="Fins' data"
            description="Proofs and reports a Fin keeps. Removed, it goes once the Fin finished and every Apex above it is closed or archived; an archived Thread's always can."
          >
            <Select aria-label="Fins' data" value={scratch.dataMode ?? "preview"} onChange={(event) => {
              const dataMode = event.target.value
              if (dataMode === "preview" || dataMode === "remove") saveScratch({ ...scratch, dataMode })
            }}>
              <option value="preview">Keep</option>
              <option value="remove">Remove</option>
            </Select>
          </SettingRow>
        ) : null}
        {worktrees ? (
          <SettingRow
            title="Worktrees of finished Fins and archived Threads"
            description={`Retired once clean, pushed and quiet for ${worktrees.days} days. A message to the Thread makes the worktree again on its branch.`}
          >
            <Toggle label="Retire the worktrees of finished Fins and archived Threads" on={worktrees.finishedFins !== false} onChange={() => saveWorktrees({ ...worktrees, finishedFins: worktrees.finishedFins === false })} />
          </SettingRow>
        ) : null}
        {rewind ? (
          <SettingRow
            title="Rewind checkpoints"
            description="The newest are kept up to this size; older settled turns' go first, and Rewind no longer reaches those turns."
          >
            <div className="flex items-center gap-2">
              <Select aria-label="Rewind checkpoints" value={rewind.mode} onChange={(event) => {
                const mode = event.target.value
                if (mode === "preview" || mode === "evict") saveRewind({ ...rewind, mode })
              }}>
                <option value="evict">Keep up to</option>
                <option value="preview">Keep all</option>
              </Select>
              <Field aria-label="Rewind checkpoints in GB" className="w-14" type="number" min={1} max={1024} disabled={rewind.mode !== "evict"} value={rewind.maxBytes / 1024 ** 3} onChange={(event) => {
                const gib = event.target.valueAsNumber
                if (whole(gib, 1, 1024)) saveRewind({ ...rewind, maxBytes: gib * 1024 ** 3 })
              }} />
              <span className="text-label text-faint">GB</span>
            </div>
          </SettingRow>
        ) : null}
      </ListCard>
      {error ? <p className="pt-2 text-label text-removed">{error}</p> : null}
    </section>
  )
}
