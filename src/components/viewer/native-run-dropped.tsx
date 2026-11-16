import { harnessLabel } from "@/lib/harness-label"
import { useRunDropped } from "@/state/native-run-dropped"

/** One quiet line under a native Thread's latest reply when it runs without a setting its harness can't carry. */
export function NativeRunDropped({ path }: { path: string }) {
  const run = useRunDropped((state) => state.runs[path])
  if (!run) return null
  const named = run.dropped.join(" and ")
  return (
    <p data-run-dropped={run.dropped.join(",")} className="shrink-0 px-5 py-1.5 text-label text-faint">
      This reply runs without {named}: {harnessLabel(run.harness)}'s command line can't carry {run.dropped.length === 1 ? "it" : "them"}.
    </p>
  )
}
