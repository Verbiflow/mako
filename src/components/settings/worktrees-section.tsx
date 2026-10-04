import { useCallback, useEffect, useState } from "react"
import { FolderOpenIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import type { WorktreeDetail, WorktreeInventory } from "../../../electron/contracts/thread-worktrees.ts"
import { Action, Blank, Chip, IconAction, ListCard, ListCardRow, SettingRow, Toggle } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { formatBytes, formatRelative } from "@/lib/format"
import { desktop } from "@/state/desktop"
import { togglePref, usePrefs } from "@/state/prefs"
import { projectName, useWorkspaceMoves, workspaceMoves } from "@/state/workspace-moves"
import { readWorktreeInventory, removable, removeLandedWorktrees, removeWorktree } from "@/state/worktrees"

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

function Landing({ worktree }: { worktree: WorktreeDetail }) {
  const { landing } = worktree
  if (landing.kind === "merged") return <Chip tone="positive">Merged into {landing.into}</Chip>
  if (landing.kind === "empty") return worktree.changes ? null : <Chip>No commits</Chip>
  if (landing.kind === "open") return <Chip>{plural(landing.commits, "commit")} not on {landing.into}</Chip>
  return null
}

/** Why the Remove button is off, or what it does. */
function removeHint(worktree: WorktreeDetail): string {
  if (worktree.users.length) return `In use by ${worktree.users.join(", ")}`
  if (worktree.held) return worktree.held
  return `Remove the folder; ${worktree.branch} keeps its commits`
}

function WorktreeRow({ worktree, onRemove }: { worktree: WorktreeDetail; onRemove: (worktree: WorktreeDetail) => void }) {
  const place = worktree.project === worktree.repoRoot
    ? folderName(worktree.repoRoot)
    : `${folderName(worktree.repoRoot)}/${worktree.project.slice(worktree.repoRoot.length + 1)}`
  const age = formatRelative(worktree.createdAt)
  return (
    <ListCardRow className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-mono text-ui text-foreground">{worktree.branch}</span>
          <Landing worktree={worktree} />
          {worktree.changes ? <Chip tone="caution">{worktree.changes} uncommitted</Chip> : null}
          {worktree.held && !worktree.changes ? <Chip tone="caution">Work under way</Chip> : null}
          {worktree.users.length ? <Chip tone="caution">In use</Chip> : null}
          {worktree.thread ? null : <Chip>No Thread</Chip>}
        </div>
        <div className="mt-0.5 truncate text-label text-faint">
          {place}
          {age ? ` · made ${age === "now" ? "just now" : `${age} ago`}` : ""}
          {worktree.bytes !== null ? ` · ${formatBytes(worktree.bytes)}` : ""}
        </div>
      </div>
      <IconAction label="Show the folder" size="xs" onClick={() => void desktop.revealPath(worktree.path)}>
        <FolderOpenIcon />
      </IconAction>
      <IconAction
        label={removeHint(worktree)}
        size="xs"
        className="hover:not-disabled:bg-negative/12 hover:not-disabled:text-negative"
        disabled={Boolean(worktree.held) || worktree.users.length > 0}
        onClick={() => onRemove(worktree)}
      >
        <Trash2Icon />
      </IconAction>
    </ListCardRow>
  )
}

export function WorktreesSection() {
  const [inventory, setInventory] = useState<WorktreeInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const read = useCallback(() => readWorktreeInventory().then(
    (next) => { setInventory(next); setError(null) },
    (reason) => setError(reason instanceof Error ? reason.message : String(reason)),
  ), [])
  useEffect(() => { void read() }, [read])

  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    try { await work() } finally {
      await read()
      setBusy(false)
    }
  }

  const worktrees = [...(inventory?.worktrees ?? [])].sort((a, b) => b.createdAt - a.createdAt)
  const landed = worktrees.filter(removable)
  const measured = worktrees.reduce((sum, worktree) => sum + (worktree.bytes ?? 0), 0)
  const spares = inventory?.spares

  return (
    <div className="flex flex-col gap-6">
      <BranchSettings />

      <section>
        <h3 className="text-ui font-medium">On this Mac</h3>
        <p className="mt-0.5 pb-3 text-label text-muted-foreground">
          A Thread on its own branch works in a worktree: its own checkout of the
          project. Removing a worktree deletes the folder and keeps the branch,
          so anything committed there stays reachable.
        </p>

        {!inventory && !error ? <p className="text-ui text-faint"><Shimmer text="Reading worktrees…" /></p> : null}

        {inventory ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="flex-1 text-label text-faint">
                {worktrees.length ? `${plural(worktrees.length, "worktree")} · ${formatBytes(measured)} of their own files` : ""}
              </span>
              <Action tone="outline" size="xs" disabled={busy} onClick={() => void act(async () => {})}>
                <RefreshCwIcon className="size-3" />
                Refresh
              </Action>
              <Action
                tone="outline"
                size="xs"
                disabled={busy || landed.length === 0}
                title="Removes worktrees whose work is on their project's branch, or that never made a commit, when removing them loses nothing and nothing runs in them"
                onClick={() => void act(() => removeLandedWorktrees(landed))}
              >
                <Trash2Icon className="size-3" />
                {landed.length ? `Remove merged (${landed.length})` : "Remove merged"}
              </Action>
            </div>

            {worktrees.length ? (
              <ListCard>
                {worktrees.map((worktree) => (
                  <WorktreeRow key={worktree.path} worktree={worktree} onRemove={(one) => void act(() => removeWorktree(one))} />
                ))}
              </ListCard>
            ) : (
              <div className="rounded-lg bg-surface ring-1 ring-hairline">
                <Blank title="No worktrees" body="Choose Own branch under the composer, and the next Thread’s worktree shows up here." />
              </div>
            )}

            {spares?.count ? (
              <p className="pt-3 text-label text-faint">
                {plural(spares.count, "spare checkout")} {spares.count === 1 ? "is" : "are"} kept ready so a new Thread on its own branch starts at once
                {spares.bytes !== null ? ` (${formatBytes(spares.bytes)})` : ""}. Mako lets them go after a day with no new Thread on its own branch.
              </p>
            ) : null}
          </>
        ) : null}

        {error ? <p className="pt-2 text-label text-removed">The worktrees couldn&apos;t be read: {error}</p> : null}
      </section>
    </div>
  )
}

/** The default for new Threads, the composer's Own branch chip in Settings, and the projects where agents may move without asking. */
function BranchSettings() {
  const ownBranch = usePrefs((prefs) => prefs.newThreadsInWorktree)
  const alwaysAllowed = useWorkspaceMoves((moves) => moves.alwaysAllowed)
  return (
    <ListCard>
      <SettingRow
        title="Start new threads on their own branch"
        description="Each new Thread in a Git project gets its own branch, in a worktree with your .env files and installed packages. Off starts it in the project folder. The composer's chip is the same switch"
      >
        <Toggle label="Start new threads on their own branch" on={ownBranch} onChange={() => togglePref("newThreadsInWorktree")} />
      </SettingRow>
      {alwaysAllowed.map((project) => (
        <SettingRow
          key={project}
          title={`Agents in ${projectName(project)} move to their own branch without asking`}
          description={`You chose Always allow for ${project}. Ask again to answer each agent that wants to move.`}
        >
          <Action onClick={() => void workspaceMoves.forget(project)}>Ask again</Action>
        </SettingRow>
      ))}
    </ListCard>
  )
}
