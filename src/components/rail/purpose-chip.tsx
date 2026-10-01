import { memo } from "react"
import type { ThreadPurposeKind } from "../../../electron/contracts/thread-purposes"
import { workspaceName } from "@/lib/format"
import { useThreadPurposes } from "@/state/thread-purposes"

const LABEL = { setup: "Setup" } satisfies Record<ThreadPurposeKind, string>
const TIP = {
  setup: (project: string | undefined) => project ? `Mako started this Thread to set up ${workspaceName(project)}` : "Mako started this Thread to set this project up",
} satisfies Record<ThreadPurposeKind, (project: string | undefined) => string>

/**
 * What Mako started a Thread for, as a plain chip after its title. The
 * host's record of the Thread decides; a row still starting shows what it
 * was started for until that record arrives. Most Threads show nothing.
 */
export const ThreadPurposeChip = memo(function ThreadPurposeChip({ thread, starting }: { thread?: string; starting?: ThreadPurposeKind }) {
  const recorded = useThreadPurposes((state) => (thread ? state.byThread[thread] : undefined))
  const kind = recorded?.kind ?? starting
  if (!kind) return null
  return (
    <span
      data-thread-purpose={kind}
      data-tip={TIP[kind](recorded?.project)}
      className="flex h-4 shrink-0 items-center rounded bg-fill-selected px-1 text-label leading-none text-muted-foreground"
    >
      {LABEL[kind]}
    </span>
  )
})
