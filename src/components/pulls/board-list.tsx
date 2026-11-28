import { useMemo } from "react"
import {
  multiRepositoryKeys,
  rowCode,
  type BoardIssue,
  type BoardProject,
  type BoardPull,
} from "@mako/host/contracts/project-pulls"
import { ListSection } from "@/components/ui/list"
import { IssueRow, PullRow } from "@/components/pulls/board-rows"
import { codeWidth } from "@/components/pulls/board-words"
import { useSections } from "@/components/pulls/use-sections"
import { toggleFolded, usePullsView, type BoardPlace } from "@/state/pulls-view"

/*
 * The sections of a board, for the panel and the page alike: by state in their fixed order (or by repository, the
 * page's Display choice), each folding under its header, merged and closed folded until opened.
 */

type Row = BoardPull | BoardIssue

export interface BoardListProps {
  place: BoardPlace
  kind: "pulls" | "issues"
  rows: readonly Row[]
  projects: readonly BoardProject[]
  now: number
  selected?: string
  onSelect: (key: string) => void
  onOpen: (key: string) => void
  /** The page's wider rows: the project each row is of, by repository key. */
  projectOf?: (row: Row) => string | undefined
}

export function BoardList({ place, kind, rows, projects, now, selected, onSelect, onOpen, projectOf }: BoardListProps) {
  const grouping = usePullsView((state) => state[place].grouping)
  const folded = usePullsView((state) => state[place].folded)
  const sections = useSections(kind, rows, place === "panel" ? "state" : grouping, now)
  const multi = useMemo(() => multiRepositoryKeys(projects), [projects])
  // Measured from the rows drawn: a folded section's longer codes don't push every title right.
  const width = useMemo(() => codeWidth(sections.flatMap((section) => (folded[`${kind}:${section.key}`] ?? section.folded) ? [] : section.rows.map((row) => rowCode(row, multi)))), [sections, folded, kind, multi])
  return (
    <>
      {sections.map((section) => {
        const key = `${kind}:${section.key}`
        const closed = folded[key] ?? section.folded
        return (
          <ListSection
            key={key}
            label={section.label}
            count={section.rows.length}
            attention={section.key === "needs-you"}
            folded={closed}
            onFold={() => toggleFolded(place, key, closed)}
            className={place === "panel" ? "pt-1.5 first:pt-0" : undefined}
          >
            {section.rows.map((row) => {
              const props = {
                selected: row.key === selected,
                multi,
                width,
                onSelect: () => onSelect(row.key),
                onOpen: () => onOpen(row.key),
                ...(projectOf && { wide: { project: projectOf(row) } }),
              }
              return "head" in row ? <PullRow key={row.key} pull={row} {...props} /> : <IssueRow key={row.key} issue={row} {...props} />
            })}
          </ListSection>
        )
      })}
    </>
  )
}
