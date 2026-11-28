import { useEffect, useMemo, useRef, useState } from "react"
import { RotateCwIcon, SlidersHorizontalIcon } from "lucide-react"
import { multiRepositoryKeys, pullSection, repositoryKey, type BoardIssue, type BoardPull } from "@mako/host/contracts/project-pulls"
import { ListPage, ListSearch, ListToolbar, ViewChips, type ListView } from "@/components/ui/list"
import { useListKeys } from "@/components/ui/use-list-keys"
import { IconAction } from "@/components/ui/kit"
import { BoardList } from "@/components/pulls/board-list"
import { ProblemLines } from "@/components/pulls/board-rows"
import { copyReference } from "@/components/pulls/board-words"
import { BoardPreview } from "@/components/pulls/pull-preview"
import { openBoardRow } from "@/components/pulls/open-board-row"
import { useProjectGroups } from "@/state/project-settings"
import { readBoard, useBoardWatch, useIssueBoard, usePullBoard } from "@/state/project-board"
import { setPullsView, usePullsView, type BoardGrouping } from "@/state/pulls-view"
import { pullsPane, useInboxView } from "@/state/inbox-view"
import { desktop } from "@/state/desktop"
import { everyWhileShown } from "@/lib/window-shown"

/*
 * Pull requests across every project, over the conversation as the Inbox is: the same sections and rows as the
 * panel, wider (author, project), with views (All, Needs you, Mine, Issues), a search, Group by repository (g),
 * and a preview of the selected row on the page's right. Enter opens a pull request as a tab; Escape goes back.
 */

type Filter = "all" | "needs" | "mine" | "issues"

function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => everyWhileShown(60_000, () => setNow(Date.now())), [])
  return now
}

/** `folders`: the projects to list, where the window's rail knows them otherwise (a browser's, from the account's list). */
export function PullsPageView({ folders }: { folders?: readonly string[] }) {
  const open = useInboxView((state) => state.pulls)
  if (!open) return null
  return <PullsPage given={folders} />
}

const projectName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder

function matches(row: BoardPull | BoardIssue, query: string): boolean {
  if (!query) return true
  const text = query.toLowerCase().replace(/^#/, "")
  return row.title.toLowerCase().includes(text) || String(row.number).startsWith(text) || row.repository.toLowerCase().includes(text) || (row.author?.toLowerCase().includes(text) ?? false)
}

function PullsPage({ given }: { given?: readonly string[] }) {
  const { active } = useProjectGroups()
  const folders = given ?? active
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const kind = filter === "issues" ? "issues" : "pulls"
  useBoardWatch(folders, kind, "shown")
  const pulls = usePullBoard(folders)
  const issues = useIssueBoard(folders)
  const board = kind === "pulls" ? pulls : issues
  const selected = usePullsView((state) => state.page.selected)
  const grouping = usePullsView((state) => state.page.grouping)
  const now = useMinute()
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  // A repository two projects share is one: its project, for the row's cell, is the first that lists it.
  const projectOfRepository = useMemo(() => {
    const by = new Map<string, string>()
    for (const project of board.projects) for (const key of project.repositories) if (!by.has(key)) by.set(key, projectName(project.folder))
    return by
  }, [board.projects])
  const multi = useMemo(() => multiRepositoryKeys(board.projects), [board.projects])
  const rows: (BoardPull | BoardIssue)[] = useMemo(() => {
    const all: readonly (BoardPull | BoardIssue)[] = board.rows
    return all.filter((row) => matches(row, query) && (
      filter === "needs" ? "head" in row && row.state === "open" && pullSection(row) === "needs-you"
      : filter === "mine" ? "head" in row && row.mine
      : true))
  }, [board.rows, filter, query])
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])
  const shown = selected ? byKey.get(selected) : undefined

  const openPulls = pulls.rows.filter((row) => row.state === "open")
  const needs = openPulls.filter((row) => pullSection(row) === "needs-you").length
  const mine = openPulls.filter((row) => row.mine).length
  const views: ListView<Filter>[] = [
    { value: "all", label: "All", count: openPulls.length || undefined },
    { value: "needs", label: "Needs you", count: needs || undefined, attention: true },
    { value: "mine", label: "Mine", count: mine || undefined },
    { value: "issues", label: "Issues", count: issues.rows.filter((row) => row.state === "open").length || undefined },
  ]
  const pick = (next: Filter) => {
    setFilter(next)
    setPullsView("page", { selected: undefined })
  }
  const openRow = (key: string) => { const row = byKey.get(key); if (row) openBoardRow(row, multi) }

  useListKeys({
    root,
    enabled: true,
    selected,
    onSelect: (key) => setPullsView("page", { selected: key }),
    onOpen: openRow,
    onBack: () => pullsPane.close(),
    search,
    views: { count: views.length, pick: (index) => pick(views[index]!.value) },
    onKey: (event, key, typing) => {
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return false
      const row = key ? byKey.get(key) : undefined
      if (event.key === "o" && row) { void desktop.openUrl(row.url); return true }
      if (event.key === "c" && row) { copyReference(row); return true }
      if (event.key === "r") { void readBoard(folders, kind, "refresh"); return true }
      if (event.key === "g") { setPullsView("page", { grouping: grouping === "repository" ? "state" : "repository" }); return true }
      return false
    },
  })

  const repositories = board.repositories.length
  const projectCount = board.projects.filter((project) => project.repositories.length).length
  const summary = board.loading && !board.rows.length
    ? "Reading…"
    : [
      needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : undefined,
      `${openPulls.length} open`,
      `${repositories} ${repositories === 1 ? "repository" : "repositories"} in ${projectCount} ${projectCount === 1 ? "project" : "projects"}`,
    ].filter(Boolean).join(" · ")

  return (
    <section data-pulls-page data-loading={board.loading || undefined} className="absolute inset-0 z-30 flex min-h-0 bg-surface">
      <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ListPage
          title="Pull requests"
          summary={summary}
          summaryTone={needs ? "attention" : "faint"}
          actions={
            <>
              <IconAction
                size="sm"
                label={grouping === "repository" ? "Group by state" : "Group by repository"}
                keys={["G"]}
                aria-pressed={grouping === "repository"}
                data-group-by-repository={grouping === "repository" || undefined}
                className={grouping === "repository" ? "bg-fill-selected text-foreground" : undefined}
                onClick={() => setPullsView("page", { grouping: grouping === "repository" ? "state" : "repository" satisfies BoardGrouping })}
              >
                <SlidersHorizontalIcon />
              </IconAction>
              <IconAction size="sm" label="Read again" keys={["R"]} onClick={() => void readBoard(folders, kind, "refresh")}><RotateCwIcon /></IconAction>
            </>
          }
          toolbar={
            <ListToolbar>
              <ViewChips views={views} value={filter} onChange={pick} label="Show" />
              <ListSearch ref={search} className="w-32 @xl/list:w-48" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search" />
            </ListToolbar>
          }
        >
          <ProblemLines repositories={board.repositories} folders={folders} kind={kind} />
          {rows.length === 0 && !board.loading ? (
            <p data-board-empty className="py-16 text-center text-ui text-faint">
              {query ? `Nothing matches "${query}"` : filter === "needs" ? "Nothing needs you" : filter === "mine" ? "None of yours are open" : kind === "pulls" ? "No open pull requests" : "No open issues"}
            </p>
          ) : (
            <BoardList
              place="page"
              kind={kind}
              rows={rows}
              projects={board.projects}
              now={now}
              selected={selected}
              onSelect={(key) => setPullsView("page", { selected: key })}
              onOpen={openRow}
              projectOf={(row) => projectOfRepository.get(repositoryKey(row.repository))}
            />
          )}
        </ListPage>
      </div>
      {shown ? <BoardPreview row={shown} multi={multi} project={projectOfRepository.get(repositoryKey(shown.repository))} /> : null}
    </section>
  )
}
