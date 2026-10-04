import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronLeftIcon, GitBranchIcon, GitPullRequestDraftIcon, GitPullRequestIcon, SearchIcon } from "lucide-react"
import type { WorktreeBranch, WorktreePull } from "../../../electron/contracts/thread-worktrees.ts"
import { Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { formatRelative } from "@/lib/format"
import { plainPath } from "@/lib/worktree-paths"
import { cn } from "@/lib/utils"
import { readWorktreeBranches, readWorktreePulls, type WorktreeStartChoice } from "@/state/worktrees"

/** Without a search the panel shows the newest few of each; a search looks through all of them. */
const RECENT_BRANCHES = 5
const RECENT_PULLS = 3
const FOUND = 30

interface Row {
  key: string
  kind: "branch" | "pull"
  name: string
  /** What Enter does, and ⌘Enter when there's a second way. */
  primary: Action
  secondary?: Action
  /** Why the second way, or the only one, can't be taken here. */
  held?: string
  branch?: WorktreeBranch
  pull?: WorktreePull
}

interface Action {
  label: string
  choice: WorktreeStartChoice
}

function where(checkedOut: string, project: string): string {
  return plainPath(checkedOut) === plainPath(project) ? "your project folder" : "a worktree"
}

function branchRow(branch: WorktreeBranch, project: string): Row {
  const local = branch.remote ? branch.name.slice(branch.name.indexOf("/") + 1) : branch.name
  const from: Action = { label: "New branch from it", choice: { start: { kind: "from", ref: branch.name }, label: branch.name } }
  const on: Action = { label: "Work on it", choice: { start: { kind: "branch", branch: branch.name }, label: local } }
  return {
    key: `branch:${branch.name}`,
    kind: "branch",
    name: branch.name,
    primary: from,
    secondary: branch.checkedOut ? undefined : on,
    held: branch.checkedOut ? `${branch.name} is checked out in ${where(branch.checkedOut, project)}` : undefined,
    branch,
  }
}

function pullRow(pull: WorktreePull, branches: readonly WorktreeBranch[], project: string): Row {
  const holder = pull.cross ? undefined : branches.find((branch) => !branch.remote && branch.name === pull.branch)?.checkedOut
  const on: Action = {
    label: `Work on #${pull.number}`,
    choice: { start: { kind: "pull", number: pull.number, branch: pull.branch, cross: pull.cross }, label: `#${pull.number}`, title: pull.title },
  }
  return {
    key: `pull:${pull.number}`,
    kind: "pull",
    name: pull.title,
    primary: on,
    held: holder ? `${pull.branch} is checked out in ${where(holder, project)}` : undefined,
    pull,
  }
}

function matches(row: Row, query: string): boolean {
  const text = row.pull ? `#${row.pull.number} ${row.pull.title} ${row.pull.branch} ${row.pull.author ?? ""}` : row.name
  return text.toLowerCase().includes(query)
}

/**
 * Where the next Thread's branch comes from, chosen by search: a new branch
 * from any branch (Enter), or the Thread working on a branch or pull request
 * as it is (⌘Enter on a branch, Enter on a pull request). A branch Git
 * already has checked out somewhere can only be started from.
 */
export function BranchSearch({ cwd, onBack, onChoose }: { cwd: string; onBack: () => void; onChoose: (choice: WorktreeStartChoice) => void }) {
  const [query, setQuery] = useState("")
  const [branches, setBranches] = useState<WorktreeBranch[]>()
  const [pulls, setPulls] = useState<WorktreePull[] | null>()
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let current = true
    void readWorktreeBranches(cwd).then((found) => current && setBranches(found), () => current && setBranches([]))
    void readWorktreePulls(cwd).then((found) => current && setPulls(found), () => current && setPulls(null))
    return () => {
      current = false
    }
  }, [cwd])

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const branchRows = (branches ?? []).map((branch) => branchRow(branch, cwd)).filter((row) => !needle || matches(row, needle))
    const pullRows = (pulls ?? []).map((pull) => pullRow(pull, branches ?? [], cwd)).filter((row) => !needle || matches(row, needle))
    return {
      branches: branchRows.slice(0, needle ? FOUND : RECENT_BRANCHES),
      pulls: pullRows.slice(0, needle ? FOUND : RECENT_PULLS),
    }
  }, [branches, pulls, query, cwd])
  const rows = [...sections.branches, ...sections.pulls]
  const shown = rows[Math.min(active, rows.length - 1)]

  useEffect(() => {
    list.current?.querySelector(`[data-row-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const take = (row: Row | undefined, second: boolean) => {
    const action = second ? row?.secondary : row?.primary
    if (!row || !action || (row.kind === "pull" && row.held)) return
    onChoose(action.choice)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((index) => (rows.length ? (Math.min(index, rows.length - 1) + step + rows.length) % rows.length : 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      take(shown, event.metaKey || event.ctrlKey)
    }
  }

  const rowView = (row: Row) => {
    const index = rows.indexOf(row)
    const on = row === shown
    const Icon = row.kind === "branch" ? GitBranchIcon : row.pull?.draft ? GitPullRequestDraftIcon : GitPullRequestIcon
    const meta = row.branch
      ? row.branch.checkedOut ? (plainPath(row.branch.checkedOut) === plainPath(cwd) ? "Project folder" : "Worktree") : formatRelative(row.branch.at)
      : [row.pull?.draft ? "Draft" : null, row.pull?.updatedAt ? formatRelative(row.pull.updatedAt) : null].filter(Boolean).join(" · ")
    return (
      <button
        key={row.key}
        type="button"
        role="option"
        aria-selected={on}
        title={row.pull ? `#${row.pull.number} ${row.pull.title}${row.pull.author ? `, by ${row.pull.author}` : ""}, on ${row.pull.branch}` : row.name}
        data-row-index={index}
        onMouseMove={() => setActive(index)}
        onClick={(event) => take(row, event.metaKey || event.ctrlKey)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
          on && "bg-fill-hover",
          row.kind === "pull" && row.held && "opacity-60"
        )}
      >
        <Icon className="size-3 shrink-0 text-faint" />
        {row.pull && <span className="shrink-0 text-ui tabular text-faint">#{row.pull.number}</span>}
        <span className="min-w-0 flex-1 truncate text-ui">{row.name}</span>
        {meta && <span className="max-w-28 shrink-0 truncate text-label text-faint tabular">{meta}</span>}
      </button>
    )
  }

  const loading = branches === undefined
  return (
    <div className="flex flex-col animate-in fade-in-0 slide-in-from-right-2 duration-150 ease-[var(--ease-out)]">
      <div className="-mx-1 -mt-1 mb-1 flex items-center gap-1 border-b border-hairline px-1.5 py-1.5">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <SearchIcon className="size-3.5 shrink-0 text-faint" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="branch-search-results"
          aria-label="Search branches and pull requests"
          placeholder="Search branches and pull requests"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint"
        />
      </div>
      <div ref={list} id="branch-search-results" role="listbox" aria-label="Branches and pull requests" className="max-h-80 overflow-y-auto overscroll-contain">
        {sections.branches.length > 0 && <p className="px-2 pt-1 pb-1 text-label text-faint">Branches</p>}
        {sections.branches.map(rowView)}
        {sections.pulls.length > 0 && <p className="px-2 pt-2 pb-1 text-label text-faint">Pull requests</p>}
        {sections.pulls.map(rowView)}
        {!loading && rows.length === 0 && (
          <p className="px-2 py-6 text-center text-ui text-faint">{query ? `Nothing named “${query.trim()}”` : "No other branches yet"}</p>
        )}
        {loading && <p className="px-2 py-6 text-center text-ui text-faint">Reading branches…</p>}
      </div>
      {shown && (
        <div title={shown.held} className="-mx-1 -mb-1 mt-1 flex min-h-8 items-center gap-3 border-t border-hairline px-3 py-1.5 text-label text-faint">
          <span className={cn("flex shrink-0 items-center gap-1.5", shown.kind === "pull" && shown.held && "opacity-50")}>
            <Keys keys={formatChord("enter")} />
            {shown.primary.label}
          </span>
          {shown.kind === "branch" && (
            <span className={cn("flex shrink-0 items-center gap-1.5", !shown.secondary && "opacity-50")}>
              <Keys keys={formatChord("mod+enter")} />
              Work on it
            </span>
          )}
        </div>
      )}
    </div>
  )
}
