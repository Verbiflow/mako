import { useEffect, useMemo, useState } from "react"
import { RefreshCwIcon } from "lucide-react"
import { Action } from "@/components/ui/kit"
import { skillColumns, skillMatrixRows } from "@/lib/skill-matrix"
import { skills, useSkills } from "@/state/skills"
import { SkillMatrix } from "./skill-matrix"
import { Shimmer } from "@/components/ui/shimmer"

export function SkillsSection() {
  const snapshot = useSkills((state) => state.snapshot)
  const status = useSkills((state) => state.status)
  const error = useSkills((state) => state.error)
  const [query, setQuery] = useState("")

  useEffect(() => {
    void skills.load()
  }, [])

  const columns = useMemo(
    () => (snapshot ? skillColumns(snapshot.providers) : []),
    [snapshot]
  )
  const rows = useMemo(
    () => (snapshot ? skillMatrixRows(snapshot, columns, query) : []),
    [snapshot, columns, query]
  )
  const handedOnly = rows.filter((row) =>
    row.cells.get("agents")?.state !== "absent" && row.installed === 1
  ).length

  return (
    <div>
      <p className="pb-3 text-ui leading-relaxed text-muted-foreground">
        Every skill Mako finds is listed once: in the universal
        <code className="mx-1 font-mono text-label">.agents/skills</code>
        folder, in each provider&apos;s own folder, and in this project. A
        <code className="mx-1 font-mono text-label">$skill</code>
        in a message reaches whichever provider answers — one that has the
        skill loads it itself, one that lacks it is handed the instructions
        inside the message. Installing puts a copy in the provider&apos;s
        folder so it loads the skill outside Mako too. Every write is
        previewed first.
      </p>

      {status === "loading" && !snapshot ? (
        <p className="text-ui text-faint"><Shimmer text="Reading skill roots…" /></p>
      ) : null}

      {snapshot ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter skills"
              aria-label="Filter skills"
              className="h-7 w-48 rounded-md bg-surface px-2 text-label text-foreground ring-1 ring-hairline placeholder:text-faint focus:ring-border focus:outline-none"
            />
            <span className="flex-1 text-label text-faint">
              {snapshot.skills.length === 1
                ? "1 skill"
                : `${snapshot.skills.length} skills`}
              {handedOnly > 0
                ? ` · ${handedOnly} only in the universal folder`
                : ""}
            </span>
            <Action
              tone="outline"
              size="xs"
              disabled={status === "loading"}
              onClick={() => void skills.load()}
            >
              <RefreshCwIcon className="size-3" />
              Refresh
            </Action>
          </div>

          {rows.length > 0 ? (
            <SkillMatrix rows={rows} columns={columns} />
          ) : (
            <p className="rounded-lg bg-surface px-3 py-8 text-center text-ui text-faint ring-1 ring-hairline">
              {snapshot.skills.length === 0
                ? "No Agent Skills were found in the universal, provider, or project folders."
                : "No skills match this filter."}
            </p>
          )}

          <p className="pt-3 text-label text-faint">
            A filled dot is a copy the provider loads itself; an outline is a
            provider that is handed the skill when a message mentions it; a
            caution dot is a copy that differs from the listed one. Open a
            dot to install, replace, or remove.
          </p>
        </>
      ) : null}

      {error ? <p className="pt-2 text-label text-removed">{error}</p> : null}
    </div>
  )
}
