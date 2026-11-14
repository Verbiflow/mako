import { hostStopping } from "../base/host-stopping.js"
import { hostSpawn, closeHostChild } from "../base/host-command.js"
import { Git, type GitTrace } from "@mako/git"
import { belowAgents } from "../base/background-priority.js"
import { hostLog } from "../base/host-log.js"
import { workspaceWrites } from "../base/workspace-writes.js"
import { GitHelper } from "./git-helper.js"

/** A Git process slower than this is logged. */
const GIT_SLOW_MS = 2_000
/** Commands that change a checkout's files, which attribution puts on Mako rather than on an agent. */
const WRITES = new Set(["checkout", "switch", "restore", "reset", "stash", "merge", "rebase", "cherry-pick", "revert", "pull", "apply", "am", "clean", "rm", "mv", "read-tree", "checkout-index"])
/** `git stash` subcommands that only read. */
const STASH_READS = new Set(["list", "show"])

/** A finished Git command that changed files Mako's checkouts hold, as a workspace write. */
function reportWrite(run: GitTrace): void {
  if (!workspaceWrites.heard || !WRITES.has(run.command)) return
  const words = run.args.slice(run.args.indexOf(run.command) + 1)
  if (run.command === "stash" && STASH_READS.has(words[0] ?? "")) return
  // Without `-u`, read-tree fills an index (often a temporary one) and writes no file.
  if (run.command === "read-tree" && !words.includes("-u")) return
  const endedAt = Date.now()
  const operation = `git ${run.command}${run.command === "stash" && words[0] && !words[0].startsWith("-") ? ` ${words[0]}` : ""}`
  workspaceWrites.publish({ kind: "git", operation, paths: [run.cwd], startedAt: endedAt - Math.ceil(run.ms), endedAt })
}

/**
 * The host's Git: background work runs below agents, and the slow processes
 * and those stopped for time are logged under `git` to explain a stall, or
 * every process with `traceAll` (`MAKO_GIT_TRACE=1`). A read's failure alone is
 * routine: probes such as `rev-parse --verify` fail by design. A write's isn't:
 * one to what a repository's checkouts share that failed is always logged
 * with Git's own words, so a branch left behind says why.
 *
 * Its processes start in the Git helper (`GitHelper`), off the host's thread, and directly while the helper is down;
 * `MAKO_GIT_HELPER=0` starts them all directly.
 */
export function hostGit(traceAll: boolean): Git {
  const direct = { spawn: hostSpawn, close: closeHostChild }
  const stopping = hostStopping()?.signal
  const helper = process.env.MAKO_GIT_HELPER === "0" ? undefined : new GitHelper(direct)
  if (helper) stopping?.addEventListener("abort", () => { void helper.stop() }, { once: true })
  return new Git({
    processes: helper?.runner() ?? direct,
    signal: stopping,
    background: belowAgents,
    trace: (run) => {
      reportWrite(run)
      const failedWrite = run.write && run.outcome !== "ok"
      if (!traceAll && !failedWrite && run.ms < GIT_SLOW_MS && run.outcome !== "timeout") return
      // A remote URL in Git's error output can carry a token.
      const stderr = (traceAll || failedWrite) && run.stderr ? { stderr: run.stderr.replace(/\/\/[^/@\s]+@/g, "//***@") } : {}
      hostLog("git", `${run.command} ${run.outcome}`, { args: run.args.slice(0, 6).join(" ").slice(0, 200), cwd: run.cwd, ms: Math.round(run.ms), queuedMs: Math.round(run.queuedMs), code: run.code ?? -1, bytes: run.bytes, ...stderr })
    },
  })
}
