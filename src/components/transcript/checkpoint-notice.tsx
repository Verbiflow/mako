import type { RunSnapshots } from "@mako/host/contracts/workspace-snapshots"

/** A missing rewind point is said on the turn, including while its answer is still coming. */
export function CheckpointNotice({ before }: { before: RunSnapshots["before"] | undefined }) {
  if (before?.kind !== "unavailable" || !before.timedOut) return null
  return <p role="note" data-turn-rewind-unavailable className="text-ui text-muted-foreground">No rewind point: the checkpoint took too long</p>
}
