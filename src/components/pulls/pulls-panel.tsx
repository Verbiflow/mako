import { useEffect, useMemo, useRef, useState } from "react"
import { RotateCwIcon } from "lucide-react"
import { boardReading, multiRepositoryKeys, type BoardIssue, type BoardKind, type BoardPull } from "@mako/host/contracts/project-pulls"
import { TabReading } from "@/components/stage/side-tab"
import { ViewChips, type ListView } from "@/components/ui/list"
import { useListKeys } from "@/components/ui/use-list-keys"
import { IconAction } from "@/components/ui/kit"
import { BoardList } from "@/components/pulls/board-list"
import { ProblemLines } from "@/components/pulls/board-rows"
import { copyReference } from "@/components/pulls/board-words"
import { usePanelFolders } from "@/components/pulls/pulls-offered"
import { openBoardRow } from "@/components/pulls/open-board-row"
import { readBoard, useBoardWatch, useIssueBoard, usePullBoard } from "@/state/project-board"
import { setPullsView, usePullsView } from "@/state/pulls-view"
import { desktop } from "@/state/desktop"
import { everyWhileShown } from "@/lib/window-shown"
import { copyAge } from "@/lib/format"

/*
 * The right panel's Pull requests: the current project's, across its repositories, beside Changes. Its tab reads
 * "N needs you" in the attention hue or "N open"; Issues are its second view. It reads while it shows, and its tab
 * reads at a glance (`useBoardWatch`).
 */

export function PullsReading() {
  const folders = usePanelFolders()
  const { rows } = usePullBoard(folders)
  const reading = boardReading(rows)
  if (!reading) return null
  return <TabReading words={reading.text} count={reading.text.split(" ")[0]} attention={reading.attention} />
}

function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => everyWhileShown(60_000, () => setNow(Date.now())), [])
  return now
}

export function PullsPanel() {
  const folders = usePanelFolders()
  const view = usePullsView((state) => state.panel.view)
  const selected = usePullsView((state) => state.panel.selected)
  useBoardWatch(folders, view, "shown")
  const pulls = usePullBoard(folders)
  const issues = useIssueBoard(folders)
  const board = view === "pulls" ? pulls : issues
  const now = useMinute()
  const root = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const rows: readonly (BoardPull | BoardIssue)[] = board.rows
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])
  const multi = useMemo(() => multiRepositoryKeys(board.projects), [board.projects])
  const views: ListView<BoardKind>[] = [
    { value: "pulls", label: "Pull requests", count: pulls.rows.filter((row) => row.state === "open").length || undefined },
    { value: "issues", label: "Issues", count: issues.rows.filter((row) => row.state === "open").length || undefined },
  ]
  const pick = (next: BoardKind) => setPullsView("panel", { view: next, selected: undefined })
  // The panel's keys while focus is in it: the conversation's keys stay the conversation's.
  useListKeys({
    root,
    enabled: focused,
    selected,
    onSelect: (key) => setPullsView("panel", { selected: key }),
    onOpen: (key) => { const row = byKey.get(key); if (row) openBoardRow(row, multi) },
    views: { count: views.length, pick: (index) => pick(views[index]!.value) },
    onKey: (event, key, typing) => {
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return false
      const row = key ? byKey.get(key) : undefined
      if (event.key === "o" && row) { void desktop.openUrl(row.url); return true }
      if (event.key === "c" && row) { copyReference(row); return true }
      if (event.key === "r") { void readBoard(folders, view, "refresh"); return true }
      return false
    },
  })
  const open = rows.filter((row) => row.state === "open").length
  const footer = [
    `${open} open`,
    board.repositories.length > 1 ? `${board.repositories.length} repositories` : undefined,
    board.readAt ? `read ${copyAge(board.readAt, now)}` : undefined,
  ].filter(Boolean).join(" · ")
  return (
    <div
      ref={root}
      data-pulls-panel
      className="flex h-full min-h-0 flex-col"
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-1.5">
        <ViewChips views={views} value={view} onChange={pick} label="Pull requests or issues" />
        <span className="flex-1" />
        <IconAction size="xs" label="Read again" keys={["R"]} onClick={() => void readBoard(folders, view, "refresh")}>
          <RotateCwIcon />
        </IconAction>
      </div>
      <div className="@container/list min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-4">
        <ProblemLines repositories={board.repositories} folders={folders} kind={view} />
        {board.loading ? (
          <p className="px-2 py-6 text-center text-label text-faint">Reading {view === "pulls" ? "pull requests" : "issues"}…</p>
        ) : rows.length === 0 && !board.repositories.some((repository) => repository.problem) ? (
          <p data-board-empty className="px-2 py-10 text-center text-ui text-faint">{view === "pulls" ? "No open pull requests" : "No open issues"}</p>
        ) : (
          <BoardList
            place="panel"
            kind={view}
            rows={rows}
            projects={board.projects}
            now={now}
            selected={selected}
            onSelect={(key) => setPullsView("panel", { selected: key })}
            onOpen={(key) => { const row = byKey.get(key); if (row) openBoardRow(row, multi) }}
          />
        )}
      </div>
      {board.repositories.length ? <p data-board-footer className="flex h-8 shrink-0 items-center bg-shell/60 px-3.5 text-label text-faint">{footer}</p> : null}
    </div>
  )
}
