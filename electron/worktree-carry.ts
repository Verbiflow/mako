import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { copyFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { belowAgents } from "./background-priority.js"
import type { Prepared } from "./thread-processes.js"
import type { SpareInstall } from "./spare-install.js"
import { inputsDigest, type CarryEntry, type PrepareStep, type Recipe } from "./thread-recipe.js"
import { discoverRepositories } from "./repository-discovery.js"
import { git, succeeds } from "@mako/git"
import { onLinux, onMac } from "./platform.js"

const execute = promisify(execFile)

/** Beside a project's checkouts: output clones being made, renamed into place when whole. */
export const CARRYING = ".carrying"
/** Spare checkouts' folders are named with this, beside the Threads' worktrees. */
export const SPARE_PREFIX = ".spare-"

export function isSpareCheckout(path: string): boolean {
  return basename(path).startsWith(SPARE_PREFIX)
}
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

/** What a new worktree's install steps can learn from the main checkout's. */
export interface CheckoutSetup {
  /** The project's recipe, saved in Mako or committed, for what a new worktree takes from the main one. */
  recipe(checkout: string): Promise<Recipe | undefined>
  prepared(checkout: string): Promise<Prepared>
  savePrepared(checkout: string, prepared: Prepared): Promise<void>
  forgetPrepared?(checkout: string): Promise<void>
  /** Runs a spare checkout's install steps in the background; without it, spares get cloned outputs only. */
  spareInstall?: SpareInstall
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
  try {
    return await ignoredIn(repoRoot)
  } catch (error) {
    // A project folder holding several repositories: each one's, under its folder, and what lies outside all of them, which no worktree checks out.
    const { roots } = await discoverRepositories(repoRoot)
    if (!roots.length || roots.includes(repoRoot)) throw error
    const inside = await Promise.all(roots.map(async (root) =>
      (await ignoredIn(root).catch((): string[] => [])).map((entry) => `${relative(repoRoot, root)}/${entry}`)))
    return [...inside.flat(), ...await outsideRepositories(repoRoot, roots)].sort()
  }
}

async function ignoredIn(repoRoot: string): Promise<string[]> {
  return (await git(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))
    .split("\0")
    .map((entry) => entry.replace(/\/+$/, ""))
    .filter((entry) => entry && entry !== ".git" && !entry.startsWith(".git/"))
}

/** What a project folder holds outside its repositories, a folder holding none named once. */
async function outsideRepositories(root: string, repositories: readonly string[], folder = root): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const path = join(folder, entry.name)
    if (repositories.includes(path)) continue
    if (entry.isDirectory() && repositories.some((repository) => repository.startsWith(`${path}/`)))
      found.push(...await outsideRepositories(root, repositories, path))
    else found.push(relative(root, path))
  }
  return found
}

/** Where Git answers for `pattern`: the repository, or in a project folder of several, the one the pattern points into. */
async function gitFor(root: string, pattern: string): Promise<{ cwd: string; inside: string; pattern: string } | undefined> {
  if (await succeeds(root, ["rev-parse", "--git-dir"])) return { cwd: root, inside: "", pattern }
  for (const repository of (await discoverRepositories(root)).roots) {
    const inside = relative(root, repository)
    if (pattern.startsWith(`${inside}/`)) return { cwd: repository, inside: `${inside}/`, pattern: pattern.slice(inside.length + 1) }
  }
  return undefined
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
    if (/[*?[\]{}]/.test(pattern)) {
      const prefix = pattern.slice(0, pattern.search(/[*?[\]{}]/))
      // Git collapses an ignored folder; ask only for a pattern aimed inside it.
      const asked = ignored.some((entry) => prefix.startsWith(`${entry}/`) && !matchesGlob(entry, pattern)) ? await gitFor(repoRoot, pattern) : undefined
      if (asked) {
        const nested = await git(asked.cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", `:(glob)${asked.pattern}`])
        for (const entry of nested.split("\0").filter(Boolean)) found.add(`${asked.inside}${entry}`)
      }
      continue
    }
    if (found.has(pattern)) continue
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
  if (onMac()) {
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
  if (onMac()) return true
  if (!onLinux()) return false
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

/** In a linked folder of a checkout: the main checkout's folder its entries link to. */
export const LINKED_MARK = ".mako-linked"

/** A package folder, linked package by package; how npm, pnpm and Yarn lay one out, not a guess about the project. */
function packageFolder(entry: string): boolean {
  return basename(entry) === "node_modules"
}

/**
 * The main checkout's `entry` linked into `checkout`, in milliseconds: a
 * file as one link to the main checkout's, a folder as a folder of this
 * checkout's own whose entries link to the main checkout's, so whatever is
 * made in it later stays this checkout's. A link in it that leads back
 * into the project, such as a workspace package, is copied as it is, so it
 * reaches this checkout's own code.
 *
 * A package folder links each package: scoped folders and `.bin`, whose
 * relative links reach this folder's packages, are made here, and other
 * dot entries are caches and the package manager's own state (`.vite`,
 * `.cache`, `.package-lock.json`), which stay each checkout's. An install
 * replaces a changed package's link with a folder of its own, but writes
 * through the link of a package that depends on it, into the main
 * checkout, so no install may run over the links (`ownPackages`).
 *
 * Built at `at`, which is renamed to the entry afterwards. Returns how
 * many links it made.
 */
export async function linkEntry(repoRoot: string, checkout: string, entry: string, at = join(checkout, entry)): Promise<number> {
  const from = join(repoRoot, entry)
  const to = at
  if (!(await lstat(from)).isDirectory()) {
    await symlink(from, to)
    return 1
  }
  const packages = packageFolder(entry)
  let links = 0
  const place = async (source: string, target: string, asIs: boolean) => {
    const info = await lstat(source)
    if (info.isSymbolicLink()) {
      const text = await readlink(source)
      const reached = resolve(dirname(source), text)
      if (asIs || (inside(reached, repoRoot) && !inside(reached, from))) {
        await symlink(isAbsolute(text) && inside(reached, repoRoot) ? join(checkout, relative(repoRoot, reached)) : text, target)
        links += 1
        return
      }
    }
    await symlink(source, target)
    links += 1
  }
  await mkdir(to, { recursive: true })
  await Promise.all((await readdir(from)).map(async (name) => {
    if (name === LINKED_MARK || (packages && name.startsWith(".") && name !== ".bin")) return
    const source = join(from, name)
    const info = await lstat(source)
    if (packages && info.isDirectory() && (name === ".bin" || name.startsWith("@"))) {
      await mkdir(join(to, name))
      await Promise.all((await readdir(source)).map((inner) => place(join(source, inner), join(to, name, inner), name === ".bin")))
    } else await place(source, join(to, name), false)
  }))
  await writeFile(join(to, LINKED_MARK), `${from}\n`)
  return links
}

/** The main checkout's entry that `entry` of a checkout links to, if Mako linked it: a folder with its mark, or a link to the same path there. */
async function linkedTo(checkout: string, entry: string): Promise<string | undefined> {
  const path = join(checkout, entry)
  const info = await lstat(path).catch(() => undefined)
  if (info?.isDirectory()) return (await readFile(join(path, LINKED_MARK), "utf8").catch(() => undefined))?.trim() || undefined
  if (!info?.isSymbolicLink()) return undefined
  const target = await readlink(path).catch(() => "")
  return isAbsolute(target) && !inside(target, checkout) && target.endsWith(`${sep}${entry}`) ? target : undefined
}

/** Which entries `patterns` match in `checkout` link to the main checkout's. */
export async function linkedPaths(checkout: string, patterns: readonly string[]): Promise<string[]> {
  if (!patterns.length) return []
  const entries = await matchedEntries(checkout, patterns)
  return (await Promise.all(entries.map(async (entry) => ((await linkedTo(checkout, entry)) ? [entry] : [])))).flat()
}

/** Which of `steps`' outputs in `checkout` link to the main checkout's. */
export function linkedEntries(checkout: string, steps: readonly PrepareStep[]): Promise<string[]> {
  return linkedPaths(checkout, steps.filter((step) => step.link).flatMap((step) => step.outputs ?? []))
}

/** Which of the recipe's carry entries in `checkout` link to the main checkout's. */
export function linkedCarry(checkout: string, recipe: Pick<Recipe, "carry">): Promise<string[]> {
  return linkedPaths(checkout, (recipe.carry ?? []).filter((entry) => entry.link).map((entry) => entry.path))
}

/**
 * Each linked output in `checkout` made its own: a clone of the main
 * checkout's, swapped in whole, so an install can run there. Where the
 * volume can't clone, or the main checkout's copy is gone, the links go
 * and the install makes it in full. Returns the entries.
 */
export async function ownPackages(checkout: string, steps: readonly PrepareStep[]): Promise<string[]> {
  const entries = await linkedEntries(checkout, steps)
  if (!entries.length) return []
  const staging = join(dirname(checkout), CARRYING)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const staged = await Promise.all(entries.map(async (entry) => {
    const to = join(checkout, entry)
    const from = (await linkedTo(checkout, entry))!
    return { entry, from, to, clone: join(staging, randomUUID()), links: join(staging, randomUUID()) }
  }))
  const present = staged.filter(({ from }) => existsSync(from))
  const cloned = await cloneTrees(present.map(({ from, clone }) => [from, clone]), false)
  for (const item of staged) {
    await rename(item.to, item.links)
    const index = present.indexOf(item)
    if (index >= 0 && cloned[index]) await rename(item.clone, item.to)
    else await rm(item.clone, { recursive: true, force: true })
    await rm(item.links, { recursive: true, force: true })
  }
  return entries
}

/**
 * A linked carry entry made this checkout's own, keeping whatever was made
 * in it here: each link to the main checkout's replaced by a clone of what
 * it reaches. Returns whether it was linked.
 */
export async function ownLinked(checkout: string, entry: string): Promise<boolean> {
  const from = await linkedTo(checkout, entry)
  if (!from) return false
  const to = join(checkout, entry)
  const staging = join(dirname(checkout), CARRYING)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const links: Array<{ source: string; link: string }> = []
  const folder = !(await lstat(to)).isSymbolicLink()
  if (!folder) links.push({ source: from, link: to })
  else {
    const collect = async (inner: string, depth: number) => {
      for (const name of await readdir(join(to, inner))) {
        const link = join(to, inner, name)
        const info = await lstat(link)
        const source = join(from, inner, name)
        if (info.isSymbolicLink() && (await readlink(link)) === source) links.push({ source, link })
        else if (info.isDirectory() && depth === 0 && packageFolder(entry) && name.startsWith("@")) await collect(name, 1)
      }
    }
    await collect("", 0)
  }
  // A link whose main checkout entry is gone leads nowhere; it goes.
  for (const { source, link } of links) if (!existsSync(source)) await rm(link, { force: true })
  const staged = links.filter(({ source }) => existsSync(source)).map((item) => ({ ...item, clone: join(staging, randomUUID()) }))
  const cloned = staged.length ? await cloneTrees(staged.map(({ source, clone }) => [source, clone]), false) : []
  for (const [index, { source, link, clone }] of staged.entries()) {
    if (!cloned[index]) await cp(source, clone, { recursive: true, verbatimSymlinks: true })
    await rename(clone, link)
  }
  if (folder) await rm(join(to, LINKED_MARK), { force: true })
  return true
}

function inside(path: string, root: string): boolean {
  const inner = relative(root, path)
  return inner === "" || (!inner.startsWith("..") && !isAbsolute(inner))
}

/** `entry` of the main checkout linked into `checkout`, built beside it and renamed in, so a reader sees all of it or none. */
async function placeLink(repoRoot: string, checkout: string, entry: string): Promise<void> {
  const staging = join(dirname(checkout), CARRYING)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const temporary = join(staging, randomUUID())
  try {
    await linkEntry(repoRoot, checkout, entry, temporary)
    await mkdir(dirname(join(checkout, entry)), { recursive: true })
    await rename(temporary, join(checkout, entry))
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

/** Entries `entries` match in the main checkout, each copied or linked; one a linking entry matches links. */
async function carriedEntries(repoRoot: string, entries: readonly CarryEntry[]): Promise<Map<string, boolean>> {
  const wanted = entries
  const [linked, copied] = await Promise.all([
    matchedEntries(repoRoot, wanted.filter((entry) => entry.link).map((entry) => entry.path)),
    matchedEntries(repoRoot, wanted.filter((entry) => !entry.link).map((entry) => entry.path)),
  ])
  return new Map([...copied.map((entry) => [entry, false] as const), ...linked.map((entry) => [entry, true] as const)])
}

/**
 * The files the recipe's `carry` names, from the main checkout, before the
 * agent starts: copied, or linked to the main checkout's. Entries the
 * checkout already has are left alone, so a retry never overwrites what the
 * Thread's agent wrote. Returns how many came.
 */
export async function carryFiles(repoRoot: string, checkout: string, entries: readonly CarryEntry[]): Promise<number> {
  let copied = 0
  for (const [entry, link] of await carriedEntries(repoRoot, entries)) {
    const from = join(repoRoot, entry)
    const to = join(checkout, entry)
    if (await lstat(to).catch(() => undefined)) continue
    const info = await lstat(from).catch(() => undefined)
    if (!info || (info.isDirectory() && virtualEnvironment(from))) continue
    if (link) {
      await placeLink(repoRoot, checkout, entry)
      copied += 1
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    if (info.isSymbolicLink() && holdsCredentials(entry)) await copyFile(from, to, constants.COPYFILE_EXCL)
    else if (info.isSymbolicLink()) await symlink(await readlink(from), to)
    else if (info.isFile() && info.size < CLONE_FROM_BYTES) await copyFile(from, to, constants.COPYFILE_EXCL)
    // Node's FICLONE never clones on macOS (libuv copies the bytes there); `cp -c` does.
    else if (info.isFile() && onMac()) await execute("/bin/cp", ["-c", "-n", from, to])
    else if (info.isFile()) await copyFile(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
    else if (info.isDirectory()) {
      const [cloned] = await cloneTrees([[from, to]], false)
      if (!cloned) {
        // Another caller may have placed it while clonefile ran; never remove or replace that copy.
        await cp(from, to, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
      }
    } else continue
    copied += 1
  }
  return copied
}

export interface BringEntry {
  path: string
  link?: boolean
}

export interface BringReport {
  copied: string[]
  linked: string[]
  /** Linked before, now this worktree's own copies. */
  owned: string[]
  existing: string[]
  missing: string[]
}

/**
 * Ignored files from the main checkout, with no value reads and no
 * replacement of the worktree's own files. Copying an entry that's linked
 * makes it the worktree's own, keeping what was made in it here.
 */
export async function bringFiles(repoRoot: string, checkout: string, entries: readonly BringEntry[]) {
  const report: BringReport = { copied: [], linked: [], owned: [], existing: [], missing: [] }
  const selected = new Map<string, boolean>()
  for (const request of entries) {
    const matches = await matchedEntries(repoRoot, [request.path])
    if (!matches.length) report.missing.push(request.path)
    for (const path of matches) {
      if (selected.has(path) && selected.get(path) !== Boolean(request.link)) throw new Error(`Both copy and link were requested for ${path}. Choose one.`)
      selected.set(path, Boolean(request.link))
    }
  }
  // Validate every selection before copying any of it.
  for (const path of selected.keys()) {
    const source = await realpath(join(repoRoot, path))
    if (!inside(source, repoRoot)) throw new Error(`${path} points outside the main checkout, so it wasn't brought.`)
    if (virtualEnvironment(source)) throw new Error(`${path} is a Python virtual environment. Run its install step in this worktree instead.`)
    let parent = dirname(join(checkout, path))
    while (!(await lstat(parent).catch(() => undefined))) parent = dirname(parent)
    if (!inside(await realpath(parent), checkout)) throw new Error(`${path}'s destination points outside this worktree, so it wasn't brought.`)
  }
  for (const [path, link] of selected) {
    const to = join(checkout, path)
    if (await lstat(to).catch(() => undefined)) {
      if (!link && (await ownLinked(checkout, path))) report.owned.push(path)
      else report.existing.push(path)
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    if (link) {
      await placeLink(repoRoot, checkout, path)
      report.linked.push(path)
    } else {
      // Env files that happen to be symlinks still become independent copies.
      const source = await realpath(join(repoRoot, path))
      const info = await lstat(source)
      if (info.isFile() && info.size < CLONE_FROM_BYTES) await copyFile(source, to, constants.COPYFILE_EXCL)
      else if (info.isFile() && onMac()) await execute("/bin/cp", ["-c", "-n", source, to])
      else if (info.isFile()) await copyFile(source, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
      else if (info.isDirectory()) {
        const [cloned] = await cloneTrees([[source, to]], false)
        if (!cloned) await cp(source, to, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
      } else throw new Error(`${path} isn't a file or folder.`)
      report.copied.push(path)
    }
  }
  return report
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
  const clones = producing.some((step) => !step.link) && (await sharesBlocks(repoRoot, checkout))
  if (producing.some((step) => !step.link) && !clones)
    result.skipped.push("This volume can't share files between copies, so each would cost its full size; installs run in full here.")
  const staging = join(dirname(checkout), CARRYING)
  const main = records ? await records.prepared(repoRoot) : { done: {} }
  for (const step of producing) {
    if (!step.link && !clones) continue
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
    if (step.link) {
      // The links are the main checkout's outputs, so there's nothing for the step to catch up on until the inputs change.
      if (staged.length) await mkdir(staging, { recursive: true, mode: 0o700 })
      for (const { entry, to, temporary } of staged) {
        try {
          await mkdir(dirname(to), { recursive: true })
          await linkEntry(repoRoot, checkout, entry, temporary)
          await rename(temporary, to)
          entries.push(entry)
        } catch {
          await rm(temporary, { recursive: true, force: true })
        }
      }
      if (entries.length) result.carried.push({ command: step.command, inputs: step.inputs, digest: here, entries })
      continue
    }
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

/** Committed, value-free templates of an env file. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|defaults|dist)$/

/** Whether a file holds credentials by its name: env files, key files and the dotfiles that keep registry or database passwords. */
export function holdsCredentials(entry: string): boolean {
  const name = basename(entry).toLowerCase()
  if (ENV_TEMPLATE.test(name)) return false
  return name === ".env" || name.startsWith(".env.") || name === ".dev.vars" || name.startsWith(".dev.vars.")
    || [".envrc", ".npmrc", ".netrc", ".pgpass", "local.settings.json"].includes(name)
    || /\.(pem|key|p12|pfx|jks|keystore)$/.test(name) || /credential|secret|service-account/.test(name)
}

/** Folders a project's own install fills with its packages, by name, whatever the language. */
const DEPENDENCY_FOLDERS = new Set(["node_modules", "bower_components", "jspm_packages", "vendor", "Pods", "Carthage", ".bundle", "elm-stuff", "deps"])

/** What a checkout lacks that the main checkout has and Git ignores: the files it needs that no checkout gets from Git. */
export interface MissingEntries {
  credentials: string[]
  dependencies: string[]
}

/**
 * The main checkout's ignored credentials files (by name) and dependency
 * folders that a new checkout wouldn't get from `recipe`, or, with
 * `checkout`, that this checkout doesn't have; less what the recipe leaves
 * to the main checkout. A Python virtual environment is left out: each
 * checkout's install makes its own.
 */
export async function missingEntries(main: string, recipe: Pick<Recipe, "carry" | "prepare" | "leave"> | undefined, checkout?: string): Promise<MissingEntries> {
  const ignored = await ignoredEntries(main).catch((): string[] => [])
  const patterns = [...(recipe?.leave ?? []), ...(checkout ? [] : [...(recipe?.carry ?? []).map((entry) => entry.path), ...(recipe?.prepare ?? []).flatMap((step) => step.outputs ?? [])])]
  const covered = (entry: string) => patterns.some((pattern) => entry === pattern || entry.startsWith(`${pattern}/`) || matchesGlob(entry, pattern))
  const missing = (entry: string) => !covered(entry) && !(checkout && existsSync(join(checkout, entry)))
  const credentials = ignored.filter((entry) => holdsCredentials(entry) && missing(entry))
  const dependencies = ignored.filter((entry) => DEPENDENCY_FOLDERS.has(basename(entry)) && !virtualEnvironment(join(main, entry)) && missing(entry))
  // A dependency folder inside another names the same install once.
  return { credentials, dependencies: dependencies.filter((entry) => !dependencies.some((outer) => entry.startsWith(`${outer}/`))) }
}

/** The missing entries as a phrase, or nothing when none are. */
export function missingText(missing: MissingEntries): string | undefined {
  const listed = (entries: string[]) => entries.length > 6 ? `${entries.slice(0, 6).join(", ")} and ${entries.length - 6} more` : entries.join(", ")
  const parts = [
    missing.credentials.length ? `${listed(missing.credentials)} (credentials, by ${missing.credentials.length === 1 ? "its name" : "their names"})` : undefined,
    missing.dependencies.length ? `${listed(missing.dependencies)} (installed packages)` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" and ") : undefined
}

/** What `clonefile` manages (85,331 files in 1.4 s, above): what a cloned folder costs each new worktree. */
const CLONED_FILES_PER_SECOND = 60_000
/** A copied folder that costs each new worktree this long is worth a word about linking it. */
const WORTH_LINKING_MS = 1_000
/** How long a save waits to count what it copies; past it, the report leaves the numbers out. */
const COUNT_MS = 5_000

interface Size {
  files: number
  bytes?: number
}

/** How many files the main checkout's `entries` hold and their size, or nothing once counting takes longer than `COUNT_MS`. */
async function sizeOf(repoRoot: string, entries: readonly string[]): Promise<Size | undefined> {
  const paths = entries.map((entry) => join(repoRoot, entry))
  const deadline = Date.now() + COUNT_MS
  const counting = (async () => {
    let files = 0
    const folders: string[] = []
    for (const path of paths) {
      const info = await lstat(path).catch(() => undefined)
      if (info?.isDirectory()) folders.push(path)
      else if (info) files += 1
    }
    while (folders.length) {
      if (Date.now() > deadline) return undefined
      const batch = folders.splice(0, 64)
      for (const [index, found] of (await Promise.all(batch.map((folder) => readdir(folder, { withFileTypes: true }).catch(() => [])))).entries()) {
        for (const item of found) {
          if (item.isDirectory()) folders.push(join(batch[index]!, item.name))
          else files += 1
        }
      }
    }
    return files
  })()
  const sizing = execute("du", ["-skc", ...paths], { timeout: COUNT_MS })
    .then(({ stdout }) => Number(stdout.trim().split("\n").at(-1)?.split("\t")[0]) * 1024, () => undefined)
  const [files, bytes] = await Promise.all([counting, sizing])
  if (files === undefined) return undefined
  return bytes !== undefined && Number.isFinite(bytes) ? { files, bytes } : { files }
}

function sizeText(size: Size): string {
  const files = `${size.files.toLocaleString("en-US")} ${size.files === 1 ? "file" : "files"}`
  if (size.bytes === undefined) return files
  const bytes = size.bytes >= 1e9 ? `${(size.bytes / 1e9).toFixed(1)} GB` : size.bytes >= 1e6 ? `${Math.round(size.bytes / 1e6)} MB` : `${Math.max(1, Math.round(size.bytes / 1e3))} KB`
  return `${files}, ${bytes}`
}

function cloneText(size: Size): string {
  const ms = (size.files / CLONED_FILES_PER_SECOND) * 1000
  return ms < WORTH_LINKING_MS ? "under a second" : `about ${(ms / 1000).toFixed(1)} s`
}

/** Whether Git tracks anything `pattern` names in the main checkout. */
async function tracked(repoRoot: string, pattern: string): Promise<boolean> {
  const asked = await gitFor(repoRoot, pattern)
  if (!asked) return false
  const spec = /[*?[\]{}]/.test(asked.pattern) ? `:(glob)${asked.pattern}` : asked.pattern
  return (await git(asked.cwd, ["ls-files", "-z", "--", spec]).catch(() => "")).length > 0
}

/**
 * What a recipe's `carry` and `outputs` find in the main checkout, for the
 * agent saving it: what each new worktree gets, what that costs, and what
 * links share. A Python virtual environment is refused, since a copy of one
 * quietly runs the main checkout's; so is a link to files Git tracks, which
 * every checkout has on its own branch.
 */
export async function carryReport(recipe: Recipe, repoRoot: string): Promise<string[]> {
  const listed = (entries: string[]) => entries.length > 6 ? `${entries.slice(0, 6).join(", ")} and ${entries.length - 6} more` : entries.join(", ")
  const isAre = (entries: readonly unknown[]) => (entries.length === 1 ? "is" : "are")
  const refuse = (entries: string[]) => {
    const unsafe = entries.filter((entry) => virtualEnvironment(join(repoRoot, entry)))
    if (unsafe.length)
      throw new Error(`Not saved: ${listed(unsafe)} ${unsafe.length === 1 ? "is a Python virtual environment, which names its own folder" : "are Python virtual environments, which name their own folders"}, so a copy would run the main checkout's packages. Leave it out of carry and outputs; the install step (such as uv sync) makes one in each checkout.`)
  }
  const lines: string[] = []
  const wanted = recipe.carry ?? []
  if (wanted.length) {
    const entries = await carriedEntries(repoRoot, recipe.carry ?? [])
    refuse([...entries.keys()])
    for (const { path } of wanted.filter((entry) => entry.link)) {
      if ([...entries.keys()].some((entry) => entry === path || matchesGlob(entry, path))) continue
      if (await tracked(repoRoot, path))
        throw new Error(`Not saved: carry links ${path}, which Git tracks, so every checkout has its own on its own branch, and a link would put this Thread's edits in the main checkout's. Mako links only files Git ignores. Leave it out of carry; to read the main checkout's copy, read it at ${join(repoRoot, path)}.`)
    }
    const copies = [...entries].filter(([, link]) => !link).map(([entry]) => entry)
    const links = [...entries].filter(([, link]) => link).map(([entry]) => entry)
    const unmatched = wanted.filter(({ path }) => ![...entries.keys()].some((entry) => entry === path || matchesGlob(entry, path))).map(({ path }) => path)
    if (copies.length) lines.push(`A new worktree gets copies of these from the main checkout before its agent starts: ${listed(copies)}.`)
    const folders = (await Promise.all(copies.map(async (entry) => ((await lstat(join(repoRoot, entry)).catch(() => undefined))?.isDirectory() ? [entry] : [])))).flat()
    for (const [index, size] of (await Promise.all(folders.map((entry) => sizeOf(repoRoot, [entry])))).entries()) {
      if (!size || (size.files / CLONED_FILES_PER_SECOND) * 1000 < WORTH_LINKING_MS) continue
      lines.push(`${folders[index]} is ${sizeText(size)}, and copying it costs each new worktree ${cloneText(size)}. If nothing the app or an agent runs writes into it, {"path": "${folders[index]}", "link": true} shares the main checkout's instead, at once.`)
    }
    if (links.length)
      lines.push(`A new worktree links ${listed(links)} to the main checkout's instead of copying ${links.length === 1 ? "it" : "them"}, so a write into ${links.length === 1 ? "it" : "one"} changes the main checkout's for every Thread. recipe_publish fails if anything writes through the links while it proves the recipe; set "link": false on what the app or an agent writes into.`)
    const credentials = [...entries.keys()].filter(holdsCredentials)
    if (credentials.length)
      lines.push(`${listed(credentials)} ${credentials.length === 1 ? "holds credentials by its name" : "hold credentials by their names"}: Mako brings ${credentials.length === 1 ? "it" : "them"} as ${credentials.length === 1 ? "it is" : "they are"}. Never open, print or copy ${credentials.length === 1 ? "it" : "them"} yourself, and never ask the user to paste a value.`)
    if (unmatched.length)
      lines.push(`carry: nothing Git ignores in the main checkout (${repoRoot}) matches ${unmatched.join(", ")} yet; files Git tracks come with every checkout anyway.`)
  }
  for (const step of recipe.prepare) {
    if (!step.outputs?.length) continue
    const entries = await matchedEntries(repoRoot, step.outputs)
    refuse(entries)
    const when = `when ${step.inputs.join(", ")} ${isAre(step.inputs)} the same there`
    if (!entries.length) lines.push(`${step.command}: nothing Git ignores in the main checkout matches ${step.outputs.join(", ")} yet; once the step has run there, new worktrees get them.`)
    else if (step.link)
      lines.push(`${step.command}: a new worktree's ${listed(entries)} link each entry to the main checkout's ${when}, so it starts without running the step. Nothing may write into them: Mako gives the worktree its own copy before the step runs there, and recipe_publish fails if anything else writes through the links while it proves the recipe. Set "link": false for outputs the app or its builds write into, such as a build cache, or that a tool won't follow out of the project; app_restart and app_check "full" show the app runs on them.`)
    else {
      const size = await sizeOf(repoRoot, entries)
      lines.push(`${step.command}: ${listed(entries)}${size ? ` (${sizeText(size)})` : ""} ${isAre(entries)} cloned into a new worktree ${when}${size ? `, ${cloneText(size)} each time` : ""}.`)
    }
  }
  const missing = missingText(await missingEntries(repoRoot, recipe))
  if (missing)
    lines.push(`A new worktree won't get ${missing}, which the main checkout has and Git ignores. Decide each one: carry a file the app, its checks or an agent reads (copied, so a Thread's change stays its own); a prepare step whose outputs name a dependency folder, so a new worktree links the main checkout's instead of installing; or leave, for one that stays the main checkout's on purpose, such as production keys. recipe_publish proves the recipe in this Thread's checkout, which may have these already, so it can't tell. worktree_status lists every ignored path.`)
  return lines
}

/** What a worktree's links reach in the main checkout: each entry the recipe links, and whether it's a folder. */
export interface LinkReach {
  root: string
  entries: { entry: string; folder: boolean }[]
}

export async function linkReach(repoRoot: string, recipe: Recipe): Promise<LinkReach> {
  const root = await realpath(repoRoot).catch(() => repoRoot)
  const patterns = [
    ...(recipe.carry ?? []).filter((entry) => entry.link).map((entry) => entry.path),
    ...recipe.prepare.filter((step) => step.link).flatMap((step) => step.outputs ?? []),
  ]
  const entries = await Promise.all((await matchedEntries(repoRoot, patterns)).map(async (entry) => {
    const info = await lstat(join(root, entry)).catch(() => undefined)
    return info && !virtualEnvironment(join(root, entry)) ? [{ entry, folder: info.isDirectory() }] : []
  }))
  return { root, entries: entries.flat() }
}

/** Where to read the file system's history for writes into what the links reach. */
export function reachRoots(reach: LinkReach): string[] {
  return reach.entries.map(({ entry }) => join(reach.root, entry))
}

/**
 * Of the paths the file system's history says changed, those in what a
 * worktree's links reach in the main checkout, relative to it: written
 * through a link, or in the main checkout where every linked worktree sees
 * it. What each checkout keeps its own doesn't count: a linked folder's
 * mark, and a package folder's caches and package manager state.
 */
export function throughLinks(reach: LinkReach, paths: readonly string[]): string[] {
  const found = paths.filter((path) => reach.entries.some(({ entry, folder }) => {
    const inner = relative(join(reach.root, entry), path)
    if (inner.startsWith("..") || isAbsolute(inner)) return false
    if (!folder) return inner === ""
    const [first] = inner.split(sep)
    return Boolean(first) && first !== LINKED_MARK && !(packageFolder(entry) && first!.startsWith("."))
  }))
  return [...new Set(found.map((path) => relative(reach.root, path)))].sort()
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
  const skip = skipped.flatMap((name) => onMac() ? ["-I", name] : [`--exclude=${name}`])
  const [command, args] = belowAgents("du", ["-sk", ...skip, path])
  const kilobytes = Number((await execute(command, args).then(({ stdout }) => stdout, () => "")).split("\t")[0])
  return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null
}

/** Deletes a tree in the background band; tens of thousands of files take seconds nobody should wait for. */
export async function removeBelowAgents(path: string): Promise<void> {
  const [command, args] = belowAgents("/bin/rm", ["-rf", path])
  await execute(command, args).catch(() => rm(path, { recursive: true, force: true }))
}
