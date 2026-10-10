import { lstat, readlink, unlink } from "node:fs/promises"
import { installCommand, installsDue, movableInstalls, spareInstalls, THREAD_PLACEHOLDER } from "./checkout-install.js"
import type { AppKey } from "./contracts/thread-environments.js"
import { memoryPressure, runKey, type MemoryPressure, type RunStatus, type ThreadProcesses } from "./thread-processes.js"
import { projectRoot, type Recipe } from "./thread-recipe.js"
import { ownPackages } from "./worktree-carry.js"

const PREPARE_KEY = runKey("prepare", "checkout")

/** How a spare checkout's install went, as its record now says. */
export type SpareInstallState = "running" | "passed" | "failed" | "stopped" | "none"

/** What a spare checkout's install needs from the host: the processes that run apps, for the Thread that claims it to find. */
export interface SpareInstall {
  /**
   * Starts what the spare can install before a Thread has it, as `app`'s
   * install, at the lowest priority. `wait` while memory is short or a
   * Thread is installing or checking; nothing when none of it is due.
   */
  start(app: AppKey, checkout: string): Promise<{ command: string; inputs: string[] } | "wait" | undefined>
  /** Records how a finished install went, for whichever checkout it moved to, and gives back what it held. */
  settle(checkout: string): Promise<SpareInstallState>
  stop(app: AppKey): Promise<void>
  /** Whether memory has run out under a running install, which then gives way. */
  critical(): Promise<boolean>
  paused<T>(app: AppKey, work: () => Promise<T>): Promise<T>
}

interface Deps {
  processes: ThreadProcesses
  recipe(checkout: string): Promise<Recipe | undefined>
  /** The environment a command Mako runs for no Thread starts from, with `values` set. */
  env(values: Record<string, string>): NodeJS.ProcessEnv
  pressure?: () => Promise<MemoryPressure>
}

export function spareInstaller(deps: Deps): SpareInstall {
  const pressure = deps.pressure ?? memoryPressure
  const { processes } = deps
  /** Another app installing or checking is a Thread's foreground work, or another spare's install. */
  const busy = async (app: AppKey) =>
    (await pressure().catch(() => "critical")) !== "normal" ||
    (await processes.active()).some((entry) => entry.app !== app && entry.runs.some((run) => run.kind !== "process"))
  return {
    async start(app, checkout) {
      const recipe = await deps.recipe(checkout)
      if (!recipe?.prepare.length) return undefined
      const record = await processes.prepared(checkout)
      if (record.pending) return undefined
      const due = spareInstalls(recipe, await installsDue(checkout, recipe.prepare, record.done))
      if (!due.length) return undefined
      if (await busy(app)) return "wait"
      if (due.some(({ step }) => step.link)) await ownPackages(checkout, due.map(({ step }) => step))
      await processes.savePrepared(checkout, { ...record, pending: Object.fromEntries(due.map((entry) => [entry.command, entry.digest])), by: app })
      const command = installCommand(due)
      const values = Object.fromEntries(Object.entries(recipe.values).filter(([, text]) => !THREAD_PLACEHOLDER.test(text)))
      await processes.touch(app, checkout)
      await processes.ofProject(app, await projectRoot(checkout))
      const result = await processes.start(app, [{ kind: "prepare", name: "checkout", command, cwd: checkout, env: deps.env(values), background: true }])
      if (!result.started.length) {
        await processes.savePrepared(checkout, record)
        return undefined
      }
      return { command, inputs: [...new Set(due.flatMap(({ step }) => step.inputs))] }
    },
    async settle(checkout) {
      const record = await processes.prepared(checkout)
      if (!record.by || !record.pending) return "none"
      const status = await installStatus(processes, record.by)
      if (status?.state.kind === "running" || status?.state.kind === "starting") return "running"
      const passed = status?.state.kind === "exited" && status.state.code === 0
      const steps = (await deps.recipe(checkout))?.prepare ?? []
      await settleHanded(processes, checkout, passed ? await movableInstalls(checkout, steps, record.pending) : {})
      if (passed) return "passed"
      return status?.state.kind === "exited" ? "failed" : "stopped"
    },
    async stop(app) {
      await processes.stop(app)
    },
    async critical() {
      return (await pressure().catch(() => "normal")) === "critical"
    },
    paused: (app, work) => processes.paused(app, work),
  }
}

/** The install run an app holds, if any. */
export async function installStatus(processes: ThreadProcesses, app: AppKey): Promise<RunStatus | undefined> {
  return (await processes.status(app)).find((entry) => runKey(entry.kind, entry.name) === PREPARE_KEY)
}

/**
 * A handed-over install has ended: the checkout's record keeps `passed` of
 * what it ran, the run's records go, and so does the link left where the
 * checkout was while it ran.
 */
export async function settleHanded(processes: ThreadProcesses, checkout: string, passed: Record<string, string>): Promise<void> {
  const record = await processes.prepared(checkout)
  if (!record.by) return
  await processes.savePrepared(checkout, { done: { ...record.done, ...passed } })
  await processes.discard(record.by).catch(() => {})
  if (record.link && (await lstat(record.link).catch(() => undefined))?.isSymbolicLink() && (await readlink(record.link).catch(() => "")) === checkout)
    await unlink(record.link).catch(() => {})
}
