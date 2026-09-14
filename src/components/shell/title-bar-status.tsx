import { useHostConnection } from "@/state/host-connection"
import { Slot } from "@/extend/slot"
import { useSession } from "@/state/session"
import { HotIndicator } from "@/components/shell/hot-indicator"
import { updates, useUpdates } from "@/state/updates"
import { ArrowUpCircleIcon, PlugZapIcon } from "lucide-react"

/**
 * What is wrong, in the titlebar's right cluster — and nothing else.
 *
 * It carried the project, the branch and the changed-file count too, which
 * repeated the workspace name already centred two inches away and put a
 * permanently-lit `70 changed` beside it. Git's own surface is Changes, which
 * shows the same count with the files under it; a second readout in the
 * chrome was clutter that never earned its width. What is left only appears
 * when it has something to say: a lost host, a downloaded update. Every piece
 * is a narrow-selector leaf, so a token stream never repaints this.
 */
export function TitleBarStatus() {
  return (
    <div className="mr-1 flex min-w-0 items-center gap-2 text-label text-faint">
      <ConnectionPill />
      <HotIndicator />
      <UpdatePill />
      <Slot name="titlebar.status" meta={undefined} />
    </div>
  )
}

function ConnectionPill() {
  const phase = useSession((state) => state.phase)
  const connected = useHostConnection((state) => state.kind === "connected")
  if (phase === "ready" && connected) return null
  return (
    <button
      type="button"
      onClick={() => location.reload()}
      title="Reconnect the agent host"
      className="no-drag flex items-center gap-1 rounded px-1.5 text-negative transition-colors duration-100 hover:bg-negative/10"
    >
      <PlugZapIcon className="size-3" />
      {!connected
        ? "Host disconnected"
        : phase === "booting"
          ? "Connecting"
          : "Agent disconnected"}
    </button>
  )
}

/**
 * A new version, once there is one. Silent until a download has finished —
 * "checking" and "up to date" are answers to a question nobody asked. The
 * install is a click, never automatic: a turn can be minutes long and hold
 * real edits, and relaunching underneath that is not an improvement.
 */
function UpdatePill() {
  const status = useUpdates((state) => state.status)
  const version = useUpdates((state) => state.available)
  if (status !== "ready") return null
  return (
    <button
      type="button"
      onClick={() => updates.install()}
      title={`Restart into ${version ?? "the new version"}`}
      className="no-drag flex items-center gap-1 rounded px-1.5 text-foreground/80 transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
    >
      <ArrowUpCircleIcon className="size-3" />
      <span>Update ready</span>
    </button>
  )
}
