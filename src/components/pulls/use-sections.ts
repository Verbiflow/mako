import { useMemo } from "react"
import { issueSections, pullSections, repositorySections, type BoardIssue, type BoardPull, type Section } from "@mako/host/contracts/project-pulls"

type Row = BoardPull | BoardIssue

/** A board's sections: by state in their fixed order, or by repository. */
export function useSections(kind: "pulls" | "issues", rows: readonly Row[], grouping: "state" | "repository", now: number): Section<Row>[] {
  return useMemo(() => {
    if (grouping === "repository") return repositorySections(rows, now)
    return kind === "pulls"
      ? pullSections(rows.filter((row): row is BoardPull => "head" in row), now)
      : issueSections(rows.filter((row): row is BoardIssue => !("head" in row)), now)
  }, [kind, rows, grouping, now])
}

