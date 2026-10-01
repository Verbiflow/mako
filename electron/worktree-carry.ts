import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { copyFile, cp, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises"
import { basename, dirname, join, matchesGlob } from "node:path"
import { promisify } from "node:util"
import { belowAgents } from "./background-priority.js"
import type { Prepared } from "./thread-processes.js"
import { holdsCredentials } from "./recipe-secrets.js"
import { inputsDigest, type PrepareStep, type Recipe } from "./thread-recipe.js"
import { git } from "./worktree-git.js"

const execute = promisify(execFile)

/** Beside a project's checkouts: output clones being made, renamed into place when whole. */
export const CARRYING = ".carrying"
/** A clone takes seconds; one staged longer ago than this was left by a host that stopped. */
export const CARRYING_STALE_MS = 60 * 60_000
/** Smaller files are copied in-process; cloning only pays for itself past the cost of starting `cp`. */
const CLONE_FROM_BYTES = 1024 * 1024

/**
 * One `clonefile(2)` per folder: APFS clones the whole tree in the kernel.
 * 85,331 files (2.2 GB) took 1.4 s and 26 MB, and the file-event service saw
 * a handful of events; `cp -c -R` clones file by file, 11.4 s and thousands
 * of events. Node can't call it, and JavaScript for Automation ships with
 * every Mac, so no helper binary is needed.
 */
const CLONE_TREES = `function run(argv) {
  ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]])
  const codes = []
  for (let i = 0; i + 1 < argv.length; i += 2) codes.push($.clonefile(argv[i], argv[i + 1], 1))
  return JSON.stringify(codes)
}`

/** What a new checkout's install steps can learn from the main checkout's. */
export interface CheckoutSetup {
  /** The project's recipe, saved in Mako or committed, for what a new checkout takes from the main one. */
  recipe(checkout: string): Promise<Recipe | undefined>
  /** The recipe's credentials files the person allows new checkouts to have. */
  grantedSecrets?(checkout: string, recipe: Recipe | undefined): Promise<string[]>
  prepared(checkout: string): Promise<Prepared>
  savePrepared(checkout: string, prepared: Prepared): Promise<void>
}

/** One install step's outputs, cloned from the main checkout for the inputs they were made from. */
export interface CarriedOutputs {
  command: string
  inputs: string[]
  digest: string
  /** Relative to the checkout. */
  entries: string[]
}

export interface OutputsCarry {
  carried: CarriedOutputs[]
  /** Why a step's outputs stayed behind, one sentence each. */
  skipped: string[]
}

/**
 * Everything `.gitignore` keeps out of a checkout, with an ignored folder
 * named once and never walked: 26 ms here with 85,331 installed files, where
 * asking for "ignored by these patterns" walks every one of them (220 ms).
 */
export async function ignoredEntries(repoRoot: string): Promise<string[]> {
  return (await git(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))
    .split("\0")
    .map((entry) => entry.replace(/\/+$/, ""))
    .filter((entry) => entry && entry !== ".git" && !entry.startsWith(".git/"))
}

/**
 * The main checkout's ignored entries a recipe names. A pattern matches an
 * entry as Git lists it; a plain path inside an ignored folder, such as
 * `config/local/settings.json`, is taken as it is.
 */
export async function matchedEntries(repoRoot: string, patterns: readonly string[]): Promise<string[]> {
  if (!patterns.length) return []
  // Outside Git there are no worktrees to carry into.
  const ignored = await ignoredEntries(repoRoot).catch((): string[] => [])
  const found = new Set(ignored.filter((entry) => patterns.some((pattern) => matchesGlob(entry, pattern))))
  for (const pattern of patterns) {
    if (/[*?[\]{}]/.test(pattern) || found.has(pattern)) continue
    if (ignored.some((entry) => pattern.startsWith(`${entry}/`)) && existsSync(join(repoRoot, pattern))) found.add(pattern)
  }
  return [...found].sort()
}

/**
 * A Python virtual environment names its own folder in its scripts, so a
 * copy runs the main checkout's interpreter and packages without a word.
 * `pyvenv.cfg` marks one (PEP 405).
 */
export function virtualEnvironment(path: string): boolean {
  return existsSync(join(path, "pyvenv.cfg"))
}

async function cloneTrees(pairs: Array<[string, string]>, background: boolean): Promise<boolean[]> {
  if (process.platform === "darwin") {
    const [command, args] = background
      ? belowAgents("/usr/bin/osascript", ["-l", "JavaScript", "-e", CLONE_TREES, ...pairs.flat()])
      : ["/usr/bin/osascript", ["-l", "JavaScript", "-e", CLONE_TREES, ...pairs.flat()]]
    const { stdout } = await execute(command, args)
    const codes: unknown = JSON.parse(stdout.trim())
    return pairs.map((_, index) => Array.isArray(codes) && codes[index] === 0)
  }
  const results: boolean[] = []
  for (const [from, to] of pairs) {
    const [command, args] = background ? belowAgents("cp", ["-a", "--reflink=always", from, to]) : ["cp", ["-a", "--reflink=always", from, to]]
    results.push(await execute(command, args).then(() => true, () => false))
  }
  return results
}

/** Whether this volume shares blocks between copies; Linux only has a per-file answer, so ask with one of Git's files. */
async function sharesBlocks(repoRoot: string, checkout: string): Promise<boolean> {
  if (process.platform === "darwin") return true
  if (process.platform !== "linux") return false
  const probe = join(checkout, `.mako-clone-probe-${randomUUID()}`)
  try {
    await copyFile(join(repoRoot, ".git", "HEAD"), probe, constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { force: true })
  }
}

/**
 * The files the recipe's `carry` names, from the main checkout, before the
 * agent starts. Entries the checkout already has are left alone, so a retry
 * never overwrites what the Thread's agent wrote. Returns how many came.
 */
export async function carryFiles(repoRoot: string, checkout: string, patterns: readonly string[]): Promise<number> {
  let copied = 0
  for (const entry of await matchedEntries(repoRoot, patterns)) {
    const from = join(repoRoot, entry)
    const to = join(checkout, entry)
    if (existsSync(to)) continue
    const info = await lstat(from).catch(() => undefined)
    if (!info || (info.isDirectory() && virtualEnvironment(from))) continue
    await mkdir(dirname(to), { recursive: true })
    if (info.isSymbolicLink()) await symlink(await readlink(from), to)
    else if (info.isFile() && info.size < CLONE_FROM_BYTES) await copyFile(from, to, constants.COPYFILE_EXCL)
    // Node's FICLONE never clones on macOS (libuv copies the bytes there); `cp -c` does.
    else if (info.isFile() && process.platform === "darwin") await execute("/bin/cp", ["-c", "-n", from, to])
    else if (info.isFile()) await copyFile(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
    else if (info.isDirectory()) {
      const [cloned] = await cloneTrees([[from, to]], false)
      if (!cloned) {
        // It wasn't there before, so whatever a failed clone left is its own.
        await rm(to, { recursive: true, force: true })
        await cp(from, to, { recursive: true, verbatimSymlinks: true })
      }
    } else continue
    copied += 1
  }
  return copied
}

/**
 * Each install step's outputs, cloned from the main checkout into one whose
 * inputs are the same, so its first install only catches up. When the main
 * checkout's own record says the step passed with those inputs, the new
 * checkout's record says so too and the step doesn't run there at all.
 *
 * Copy-on-write only: where the volume can't share blocks, a copy would cost
 * the outputs' full size per worktree, so nothing is carried. Each entry is
 * cloned beside its place and renamed in, so a process reading the checkout
 * sees it whole or not at all, and one that installed first keeps its own.
 */
export async function carryOutputs(repoRoot: string, checkout: string, steps: readonly PrepareStep[], records?: Pick<CheckoutSetup, "prepared" | "savePrepared">, background = false): Promise<OutputsCarry> {
  const result: OutputsCarry = { carried: [], skipped: [] }
  const producing = steps.filter((step) => step.outputs?.length)
  if (!producing.length) return result
  if (!(await sharesBlocks(repoRoot, checkout))) {
    result.skipped.push("This volume can't share files between copies, so each would cost its full size; installs run in full here.")
    return result
  }
  const staging = join(dirname(checkout), CARRYING)
  const main = records ? await records.prepared(repoRoot) : { done: {} }
  for (const step of producing) {
    const [there, here] = await Promise.all([inputsDigest(repoRoot, step.inputs), inputsDigest(checkout, step.inputs)])
    if (there !== here) {
      result.skipped.push(`${step.command}: ${step.inputs.join(", ")} ${step.inputs.length === 1 ? "differs" : "differ"} from the main checkout's, so it installs here in full.`)
      continue
    }
    const matched = await matchedEntries(repoRoot, step.outputs ?? [])
    const unsafe = matched.filter((entry) => virtualEnvironment(join(repoRoot, entry)))
    for (const entry of unsafe) result.skipped.push(`${entry} is a Python virtual environment, which names its own folder; it's made here instead.`)
    const wanted = matched.filter((entry) => !unsafe.includes(entry) && !existsSync(join(checkout, entry)))
    const staged = wanted.map((entry) => ({ entry, from: join(repoRoot, entry), to: join(checkout, entry), temporary: join(staging, randomUUID()) }))
    const entries: string[] = []
    if (staged.length) {
      await mkdir(staging, { recursive: true, mode: 0o700 })
      await Promise.all(staged.map(({ to }) => mkdir(dirname(to), { recursive: true })))
      const cloned = await cloneTrees(staged.map(({ from, temporary }) => [from, temporary]), background)
      for (const [index, { entry, to, temporary }] of staged.entries()) {
        if (!cloned[index]) {
          await rm(temporary, { recursive: true, force: true })
          continue
        }
        try {
          await rename(temporary, to)
          entries.push(entry)
        } catch {
          await removeBelowAgents(temporary)
        }
      }
      if (entries.length < staged.length) result.skipped.push(`${step.command}: ${staged.length - entries.length} of its outputs couldn't be cloned on this volume.`)
    }
    if (entries.length) result.carried.push({ command: step.command, inputs: step.inputs, digest: here, entries })
    const whole = matched.length > 0 && !unsafe.length && matched.every((entry) => existsSync(join(checkout, entry)))
    if (records && whole && main.done[step.command] === there) {
      const current = await records.prepared(checkout)
      // A run under way records its own outcome; claiming it done beneath it would outlive a failure.
      if (!current.pending && current.done[step.command] !== here)
        await records.savePrepared(checkout, { ...current, done: { ...current.done, [step.command]: here } })
    }
  }
  return result
}

/**
 * What a recipe's `carry`, `secrets` and `outputs` find in the main
 * checkout, one sentence each, for the agent saving it. A Python virtual
 * environment in carry or outputs is refused, since a copy of one quietly
 * runs the main checkout's; so is a credentials file in carry, which
 * belongs under `secrets` for the person to allow. `granted` is what the
 * person allows of the secrets now.
 */
export async function carryReport(recipe: Recipe, repoRoot: string, granted: readonly string[] = []): Promise<string[]> {
  const listed = (entries: string[]) => entries.length > 6 ? `${entries.slice(0, 6).join(", ")} and ${entries.length - 6} more` : entries.join(", ")
  const refuse = (entries: string[]) => {
    const unsafe = entries.filter((entry) => virtualEnvironment(join(repoRoot, entry)))
    if (unsafe.length)
      throw new Error(`Not saved: ${listed(unsafe)} ${unsafe.length === 1 ? "is a Python virtual environment, which names its own folder" : "are Python virtual environments, which name their own folders"}, so a copy would run the main checkout's packages. Leave it out of carry and outputs; the install step (such as uv sync) makes one in each checkout.`)
  }
  const lines: string[] = []
  if (recipe.carry?.length) {
    const entries = await matchedEntries(repoRoot, recipe.carry)
    const credentials = [...new Set([...recipe.carry, ...entries].filter(holdsCredentials))]
    if (credentials.length)
      throw new Error(`Not saved: ${listed(credentials)} ${credentials.length === 1 ? "holds credentials by its name, so it goes" : "hold credentials by their names, so they go"} under "secrets", not "carry". The user allows secrets in Mako, and new checkouts get them only then; nobody reads them.`)
    refuse(entries)
    lines.push(entries.length
      ? `A new checkout gets these from the main checkout before its agent starts: ${listed(entries)}.`
      : `carry: nothing Git ignores in the main checkout (${repoRoot}) matches ${recipe.carry.join(", ")} yet; files Git tracks come with every checkout anyway.`)
  }
  if (recipe.secrets?.length) {
    const entries = await matchedEntries(repoRoot, recipe.secrets)
    refuse(entries)
    const waiting = recipe.secrets.filter((pattern) => !granted.includes(pattern))
    if (!entries.length)
      lines.push(`secrets: nothing Git ignores in the main checkout (${repoRoot}) matches ${recipe.secrets.join(", ")} yet.`)
    else if (!waiting.length)
      lines.push(`The user allows these credentials files, so a new checkout gets them from the main checkout before its agent starts: ${listed(entries)}.`)
    else
      lines.push(`These hold credentials: ${listed(entries)}. A new checkout gets them only once the user allows it in Mako (Settings, then Apps, then this project); until then, Threads other than the main checkout start without them. Tell the user, in a sentence, which files they are, what the app needs them for, and that they can allow them there. Never ask the user to paste a value.`)
  }
  for (const step of recipe.prepare) {
    if (!step.outputs?.length) continue
    const entries = await matchedEntries(repoRoot, step.outputs)
    refuse(entries)
    lines.push(entries.length
      ? `${step.command}: ${listed(entries)} ${entries.length === 1 ? "is" : "are"} cloned into a new checkout when ${step.inputs.join(", ")} ${step.inputs.length === 1 ? "is" : "are"} the same there.`
      : `${step.command}: nothing Git ignores in the main checkout matches ${step.outputs.join(", ")} yet; once the step has run there, new checkouts get them.`)
  }
  return lines
}

/**
 * The names `du` leaves out of a checkout's own size: output folders cloned in
 * share the main checkout's blocks. Only plain names; `du` would read `dist/*`'s
 * `*` as everything.
 */
export function outputNames(recipe: Recipe | undefined): string[] {
  const names = (recipe?.prepare ?? []).flatMap((step) => step.outputs ?? []).map((pattern) => basename(pattern))
  return [...new Set(names.filter((name) => name && !/[*?[\]{}]/.test(name)))]
}

/** A checkout's own size, in the background band, without the named output folders. */
export async function ownBytes(path: string, skipped: readonly string[] = []): Promise<number | null> {
  const skip = skipped.flatMap((name) => process.platform === "darwin" ? ["-I", name] : [`--exclude=${name}`])
  const [command, args] = belowAgents("du", ["-sk", ...skip, path])
  const kilobytes = Number((await execute(command, args).then(({ stdout }) => stdout, () => "")).split("\t")[0])
  return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null
}

/** Deletes a tree in the background band; tens of thousands of files take seconds nobody should wait for. */
export async function removeBelowAgents(path: string): Promise<void> {
  const [command, args] = belowAgents("/bin/rm", ["-rf", path])
  await execute(command, args).catch(() => rm(path, { recursive: true, force: true }))
}
