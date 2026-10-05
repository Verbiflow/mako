import { useCallback, useEffect, useState } from "react"
import { FolderOpenIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import type { WorktreeInventory } from "../../../electron/contracts/thread-worktrees.ts"
import { Action, Blank, Chip, IconAction, ListCard, ListCardRow, SettingRow, Toggle } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { formatBytes, formatRelative } from "@/lib/format"
import { desktop } from "@/state/desktop"
import { togglePref, usePrefs } from "@/state/prefs"
import { projectName, useWorkspaceMoves, workspaceMoves } from "@/state/workspace-moves"
import { removable, worktreeCheckouts, type CheckoutDetail } from "@/lib/worktree-removal"
import { leavingWorktrees, readWorktreeInventory, removeCheckout, removeLandedWorktrees, useLeavingWorktrees } from "@/state/worktrees"

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

function Landing({ checkout }: { checkout: CheckoutDetail }) {
  const { landing } = checkout
  if (landing.kind === "merged") return <Chip tone="positive">Merged into {landing.into}</Chip>
  if (landing.kind === "empty") return checkout.changes ? null : <Chip>No commits</Chip>
  if (landing.kind !== "open") return null
  if (checkout.worktrees.length === 1) return <Chip>{plural(landing.commits, "commit")} not on {landing.into}</Chip>
  // Each repository's branch lands on its own, into a branch that may be named differently.
  return checkout.worktrees.map((worktree) => worktree.landing.kind === "open" ? (
    <Chip key={worktree.path}>{plural(worktree.landing.commits, "commit")} not on {worktree.landing.into} in {folderName(worktree.repoRoot)}</Chip>
  ) : null)
}

/** Why the Remove button is off, or what it does. */
function removeHint(checkout: CheckoutDetail): string {
  if (checkout.users.length) return `In use by ${checkout.users.join(", ")}`
  if (checkout.held) return checkout.held
  if (checkout.worktrees.length > 1) return `Remove the folder and its ${checkout.worktrees.length} worktrees; ${checkout.branch} keeps its commits in each repository`
  return `Remove the folder; ${checkout.branch} keeps its commits`
}

/** The project and, in a project folder of several repositories, which ones. */
function placeOf(checkout: CheckoutDetail): string {
  const [only, ...others] = checkout.worktrees
  if (!only) return folderName(checkout.project)
  if (others.length) return `${folderName(checkout.project)}: ${checkout.worktrees.map((worktree) => worktree.repoRoot.slice(checkout.project.length + 1)).join(", ")}`
  return only.project === only.repoRoot
    ? folderName(only.repoRoot)
    : `${folderName(only.repoRoot)}/${only.project.slice(only.repoRoot.length + 1)}`
}

function WorktreeRow({ checkout, onRemove }: { checkout: CheckoutDetail; onRemove: (checkout: CheckoutDetail) => void }) {
  const age = formatRelative(checkout.createdAt)
  return (
    <ListCardRow className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-mono text-ui text-foreground">{checkout.branch}</span>
          <Landing checkout={checkout} />
          {checkout.changes ? <Chip tone="caution">{checkout.changes} uncommitted</Chip> : null}
          {checkout.held && !checkout.changes ? <Chip tone="caution">Work under way</Chip> : null}
          {checkout.users.length ? <Chip tone="caution">In use</Chip> : null}
          {checkout.thread ? null : <Chip>No Thread</Chip>}
        </div>
        <div className="mt-0.5 truncate text-label text-faint">
          {placeOf(checkout)}
          {age ? ` · made ${age === "now" ? "just now" : `${age} ago`}` : ""}
          {checkout.bytes !== null ? ` · ${formatBytes(checkout.bytes)}` : ""}
        </div>
      </div>
      <IconAction label="Show the folder" size="xs" onClick={() => void desktop.revealPath(checkout.path)}>
        <FolderOpenIcon />
      </IconAction>
      <IconAction
        label={removeHint(checkout)}
        size="xs"
        className="hover:not-disabled:bg-negative/12 hover:not-disabled:text-negative"
        disabled={Boolean(checkout.held) || checkout.users.length > 0}
        onClick={() => onRemove(checkout)}
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
  // A removal waits out its Undo: read again as one starts, is undone, or runs.
  useEffect(() => leavingWorktrees.subscribe(() => void read()), [read])
  const leaving = useLeavingWorktrees((state) => state.byPath)

  const act = async (work: () => Promise<void> | void) => {
    setBusy(true)
    try { await work() } finally {
      await read()
      setBusy(false)
    }
  }

  const worktrees = worktreeCheckouts(inventory?.worktrees ?? []).filter((checkout) => !checkout.worktrees.some((worktree) => leaving[worktree.path]))
  const landed = worktrees.filter(removable)
  const measured = worktrees.reduce((sum, checkout) => sum + (checkout.bytes ?? 0), 0)
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
                {worktrees.map((checkout) => (
                  <WorktreeRow key={checkout.path} checkout={checkout} onRemove={(one) => void act(() => removeCheckout(one))} />
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
  const tidy = usePrefs((prefs) => prefs.removeLandedOnArchive)
  const alwaysAllowed = useWorkspaceMoves((moves) => moves.alwaysAllowed)
  return (
    <ListCard>
      <SettingRow
        title="Start new threads on their own branch"
        description="Each new Thread in a Git project gets its own branch, in a worktree with your .env files and installed packages. Off starts it in the project folder. The composer's chip is the same switch"
      >
        <Toggle label="Start new threads on their own branch" on={ownBranch} onChange={() => togglePref("newThreadsInWorktree")} />
      </SettingRow>
      <SettingRow
        title="Remove a worktree when its Thread is archived, once its work has landed"
        description="Only when everything it committed is in its project's branch, nothing is left uncommitted and nothing runs there. The archive toast's Undo brings back both. Off, the toast offers the removal instead"
      >
        <Toggle label="Remove a worktree when its Thread is archived, once its work has landed" on={tidy} onChange={() => togglePref("removeLandedOnArchive")} />
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
