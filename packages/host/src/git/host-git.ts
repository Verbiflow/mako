import { Git } from "@mako/git"
import { belowAgents } from "../base/background-priority.js"
import { hostLog } from "../base/host-log.js"

/** A Git process slower than this is logged. */
const GIT_SLOW_MS = 2_000

/**
 * The host's Git: background work runs below agents, and the slow processes
 * and those stopped for time are logged under `git` to explain a stall, or
 * every process with `traceAll` (`MAKO_GIT_TRACE=1`). Failures alone are
 * routine: probes such as `rev-parse --verify` fail by design.
 */
export function hostGit(traceAll: boolean): Git {
  return new Git({
    background: belowAgents,
    trace: (run) => {
      if (!traceAll && run.ms < GIT_SLOW_MS && run.outcome !== "timeout") return
      // A remote URL in Git's error output can carry a token.
      const stderr = traceAll && run.stderr ? { stderr: run.stderr.replace(/\/\/[^/@\s]+@/g, "//***@") } : {}
      hostLog("git", `${run.command} ${run.outcome}`, { args: run.args.slice(0, 6).join(" ").slice(0, 200), cwd: run.cwd, ms: Math.round(run.ms), queuedMs: Math.round(run.queuedMs), code: run.code ?? -1, bytes: run.bytes, ...stderr })
    },
  })
}
