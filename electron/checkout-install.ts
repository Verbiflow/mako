import { randomUUID } from "node:crypto"
import { mkdir, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { inputsDigest, projectRoot, type PrepareStep, type Recipe } from "./thread-recipe.js"
import { CARRYING, linkedEntries, matchedEntries, removeBelowAgents, virtualEnvironment } from "./worktree-carry.js"

/** One of a recipe's install steps that runs, with the digest of its inputs it records once it passes. */
export interface DueInstall {
  step: PrepareStep
  command: string
  digest: string
}

/** Mako's values that differ between Threads; a recipe value built from one of them differs too. */
export const THREAD_PLACEHOLDER = /\{(?:port(?:\+\d+)?|host|url|data|thread)\}/

/**
 * The due steps as one command, stopping at the first that fails. Each runs
 * in a subshell from the checkout's root, so one step's `cd` can't move the next.
 */
export function installCommand(due: readonly DueInstall[]): string {
  return due.length === 1 ? due[0]!.command : due.map((entry) => `(${entry.command})`).join(" && ")
}

/** The recipe's install steps whose inputs changed since they last passed in `checkout`, in the recipe's order. */
export async function installsDue(checkout: string, steps: readonly PrepareStep[], done: Record<string, string>): Promise<DueInstall[]> {
  const digests = await Promise.all(steps.map((step) => inputsDigest(checkout, step.inputs)))
  const root = await projectRoot(checkout)
  const linked = root === checkout ? [] : await linkedEntries(checkout, steps)
  const mains = linked.length ? await Promise.all(steps.map((step) => step.link ? inputsDigest(root, step.inputs) : undefined)) : []
  return steps.flatMap((step, index) => {
    if (done[step.command] === digests[index]) return []
    // Linked packages are the main checkout's own, so there's nothing to catch up on while the inputs match it.
    if (step.link && linked.length && mains[index] === digests[index]) return []
    return [{ step, command: step.command, digest: digests[index]! }]
  })
}

/**
 * What the install steps that just passed record: their inputs as the
 * install left them, since one such as npm install can rewrite its own lockfile.
 */
export async function installedDigests(checkout: string, steps: readonly PrepareStep[], pending: Record<string, string>): Promise<Record<string, string>> {
  const ran = steps.filter((step) => pending[step.command] !== undefined)
  return Object.fromEntries(await Promise.all(ran.map(async (step) => [step.command, await inputsDigest(checkout, step.inputs)] as const)))
}

/**
 * What a spare checkout installs before any Thread has it: the leading due
 * steps that write into the checkout (they name `outputs`) and whose
 * commands use none of the values that differ between Threads. The rest
 * waits for the Thread, so the recipe's order holds.
 */
export function spareInstalls(recipe: Recipe, due: readonly DueInstall[]): DueInstall[] {
  const names = Object.entries(recipe.values).filter(([, text]) => THREAD_PLACEHOLDER.test(text)).map(([name]) => name)
  const uses = (command: string) => /MAKO_THREAD_/.test(command) || names.some((name) => new RegExp(`\\$\\{?${name}\\b`).test(command))
  const first = due.findIndex((entry) => !entry.step.outputs?.length || uses(entry.command))
  return first < 0 ? [...due] : due.slice(0, first)
}

/**
 * What an install that ran in a spare checkout still vouches for once the
 * checkout has moved: every step up to the first whose outputs hold a
 * Python virtual environment, which names its own folder and breaks when
 * moved. Those environments are set aside, so the Thread's install makes
 * them again where the Thread works.
 */
export async function movableInstalls(checkout: string, steps: readonly PrepareStep[], pending: Record<string, string>): Promise<Record<string, string>> {
  const kept: Record<string, string> = {}
  for (const step of steps) {
    if (pending[step.command] === undefined) continue
    const environments = (await matchedEntries(checkout, step.outputs ?? []).catch(() => [])).filter((entry) => virtualEnvironment(join(checkout, entry)))
    if (environments.length) {
      const staging = join(dirname(checkout), CARRYING)
      await mkdir(staging, { recursive: true, mode: 0o700 })
      for (const entry of environments) {
        const aside = join(staging, randomUUID())
        if (await rename(join(checkout, entry), aside).then(() => true, () => false)) void removeBelowAgents(aside)
      }
      break
    }
    kept[step.command] = await inputsDigest(checkout, step.inputs)
  }
  return kept
}
