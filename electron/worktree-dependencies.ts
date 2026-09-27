import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { belowAgents } from "./background-priority.js"
import { git } from "./worktree-git.js"

const execute = promisify(execFile)

/** Whichever of these a project has decides whether its installed packages still fit a checkout. */
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]
const DEPENDENCY_FOLDERS = new Set(["node_modules"])

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

export interface DependencyCarry {
  /** Folders cloned in, relative to the checkout. */
  carried: string[]
  /** Why nothing was carried, when there was something to carry. */
  skipped?: string
}

/** What the installed packages were resolved from: the lockfiles, or `package.json` without one. */
export async function lockDigest(folder: string): Promise<string> {
  const hash = createHash("sha256")
  let found = false
  for (const name of LOCKFILES) {
    const text = await readFile(join(folder, name)).catch(() => null)
    if (!text) continue
    hash.update(`${name}\0`).update(text)
    found = true
  }
  if (!found) {
    const manifest = await readFile(join(folder, "package.json")).catch(() => null)
    if (!manifest) return ""
    hash.update(manifest)
  }
  return hash.digest("hex")
}

async function differingLockfile(repoRoot: string, checkout: string): Promise<string | undefined> {
  for (const name of [...LOCKFILES, "package.json"]) {
    const [main, copy] = await Promise.all([readFile(join(repoRoot, name)).catch(() => null), readFile(join(checkout, name)).catch(() => null)])
    if ((main === null) !== (copy === null) || (main && copy && !main.equals(copy))) return name
  }
  return undefined
}

/** The main checkout's installed dependency folders, at any depth; Git reports an ignored folder once, without walking it. */
export async function dependencyFolders(repoRoot: string): Promise<string[]> {
  return (await ignoredEntries(repoRoot)).filter((entry) => DEPENDENCY_FOLDERS.has(basename(entry)))
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

/** Whether this volume shares blocks between copies; Linux only has a per-file answer, so ask with one file. */
async function sharesBlocks(repoRoot: string, checkout: string): Promise<boolean> {
  if (process.platform === "darwin") return true
  if (process.platform !== "linux") return false
  const sample = [...LOCKFILES, "package.json"].map((name) => join(repoRoot, name)).find((path) => existsSync(path))
  if (!sample) return false
  const probe = join(checkout, `.mako-clone-probe-${randomUUID()}`)
  try {
    await copyFile(sample, probe, constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { force: true })
  }
}

/**
 * The main checkout's installed dependencies, cloned into a checkout whose
 * lockfiles match it, so an agent's first test run doesn't start with an
 * install. Copy-on-write only: where the volume can't share blocks, a copy
 * would cost the folder's full size per worktree, so nothing is carried.
 * Each folder is cloned beside its place and renamed in, so a process
 * reading the checkout sees it whole or not at all, and one that installed
 * first keeps its own.
 */
export async function carryDependencies(repoRoot: string, checkout: string, background = false): Promise<DependencyCarry> {
  const folders = (await dependencyFolders(repoRoot)).filter((entry) => !existsSync(join(checkout, entry)))
  if (!folders.length) return { carried: [] }
  const differs = await differingLockfile(repoRoot, checkout)
  if (differs) return { carried: [], skipped: `${differs} differs from the main checkout's` }
  if (!(await sharesBlocks(repoRoot, checkout))) return { carried: [], skipped: "this volume can't share files between copies, so each would cost its full size" }
  const staged = folders.map((entry) => ({ entry, from: join(repoRoot, entry), to: join(checkout, entry), temporary: join(checkout, dirname(entry), `.${basename(entry)}.mako-${randomUUID().slice(0, 8)}`) }))
  await Promise.all(staged.map(({ temporary }) => mkdir(dirname(temporary), { recursive: true })))
  const cloned = await cloneTrees(staged.map(({ from, temporary }) => [from, temporary]), background)
  const carried: string[] = []
  for (const [index, { entry, to, temporary }] of staged.entries()) {
    if (!cloned[index]) {
      await rm(temporary, { recursive: true, force: true })
      continue
    }
    try {
      await rename(temporary, to)
      carried.push(entry)
    } catch {
      await removeBelowAgents(temporary)
    }
  }
  if (!carried.length) return { carried, skipped: "this volume can't clone folders" }
  return { carried }
}

/**
 * A checkout's own size, in the background band. Dependency folders are left
 * out: cloned from the main checkout, they share its blocks, and `du` would
 * count each clone at full size.
 */
export async function ownBytes(path: string): Promise<number | null> {
  const skip = [...DEPENDENCY_FOLDERS].flatMap((name) => process.platform === "darwin" ? ["-I", name] : [`--exclude=${name}`])
  const [command, args] = belowAgents("du", ["-sk", ...skip, path])
  const kilobytes = Number((await execute(command, args).then(({ stdout }) => stdout, () => "")).split("\t")[0])
  return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null
}

/** Deletes a tree in the background band; tens of thousands of files take seconds nobody should wait for. */
export async function removeBelowAgents(path: string): Promise<void> {
  const [command, args] = belowAgents("/bin/rm", ["-rf", path])
  await execute(command, args).catch(() => rm(path, { recursive: true, force: true }))
}
