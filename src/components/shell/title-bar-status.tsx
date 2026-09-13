import { useHostConnection } from "@/state/host-connection"
import { Slot } from "@/extend/slot"
import { actions, useSession } from "@/state/session"
import { stage } from "@/state/stage"
import { workspaceName } from "@/lib/format"
import { HotIndicator } from "@/components/shell/hot-indicator"
import { AttentionPill } from "@/components/shell/attention-pill"
import { updates, useUpdates } from "@/state/updates"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import {
  ArrowUpCircleIcon,
  FolderIcon,
  GitBranchIcon,
  PlugZapIcon,
} from "lucide-react"

/**
 * The always-on facts, in the titlebar's right cluster: where we are, what
 * branch, whether anything is listening, and — once one has downloaded — an
 * update. The old 22px status bar carried these; a strip of chrome whose
 * whole job was five small facts did not earn its height, so the facts moved
 * up here and the context/cost readings moved down beside the composer.
 * Every piece is a narrow-selector leaf: a token stream never repaints this.
 */
export function TitleBarStatus() {
  return (
    <div className="mr-1 flex min-w-0 items-center gap-2 text-label text-faint">
      <ConnectionPill />
      <AttentionPill />
      <ProjectContext />
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

function ProjectContext() {
  const { cwd, ready } = useWorkspaceFocus()
  const branch = useSession((state) => state.git?.branch)
  const changed = useSession((state) => state.git?.files.length ?? 0)
  if (!cwd) return null
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        onClick={() => void actions.pickWorkspace()}
        title={cwd}
        className="no-drag flex min-w-0 items-center gap-1 rounded px-1 transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
      >
        <FolderIcon className="size-3" />
        <span className="max-w-[9rem] truncate">{workspaceName(cwd)}</span>
      </button>
      {ready && branch ? (
        <>
          <span aria-hidden className="text-faint/50">
            /
          </span>
          <button
            type="button"
            onClick={() => stage.open("changes")}
            title={`${branch}${changed > 0 ? ` · ${changed} changed` : ""}`}
            className="no-drag flex min-w-0 items-center gap-1 rounded px-1 transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
          >
            <GitBranchIcon className="size-3" />
            <span className="max-w-[8rem] truncate font-mono">{branch}</span>
            {changed > 0 ? (
              <span className="text-caution">{changed} changed</span>
            ) : null}
          </button>
        </>
      ) : null}
    </div>
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
