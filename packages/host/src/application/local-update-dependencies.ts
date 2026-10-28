import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import type { MissingDependencies } from "../contracts/app-lifecycle.js"
import { missingDependenciesText } from "../contracts/update-source-text.js"

/**
 * A local build compiles with the source checkout's node_modules, so before
 * it copies anything that node_modules must hold what the checkout's
 * package-lock.json lists. Bringing the checkout forward (or the person's
 * own pull) can change the lockfile without an install after it: a new
 * workspace package once stopped every build with "Run npm install there".
 * Settings › Updates and `npm run update:local` now run that install
 * themselves, here, with the npm and Node the build uses.
 *
 * Install scripts: npm's `allowScripts` lets unreviewed dependency scripts
 * run with a notice today and holds them back on newer releases. The build
 * needs none of the ones the lockfile has (`test-local-update-dependencies`
 * names each and why), so nothing is approved here.
 */

/** npm install over a slow registry takes minutes; one that hasn't finished by now is stopped and named. */
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000

/**
 * `npm install`, never `npm ci`: ci deletes node_modules first, under an
 * editor or a dev server reading it. `--no-save` keeps npm from rewriting
 * package.json and package-lock.json, which stay exactly as Git has them.
 */
export const DEPENDENCY_INSTALL_ARGS = ["install", "--no-audit", "--no-fund", "--no-save"]

/** How many packages a reading names; the rest are counted. */
const NAMED = 3

const HIDDEN_LOCKFILE = join("node_modules", ".package-lock.json")
const lockPackages = z.object({
  packages: z.record(z.string(), z.object({
    version: z.string().optional(),
    optional: z.boolean().optional(),
    devOptional: z.boolean().optional(),
    peer: z.boolean().optional(),
  })).optional(),
})

/**
 * Packages the checkout's package-lock.json lists that its node_modules
 * doesn't hold at that version, by name. npm records what it installed in
 * node_modules/.package-lock.json on every install; with no such record
 * nothing installed counts. Optional and peer entries are left out, since
 * npm skips the ones for other platforms. Empty without a lockfile.
 */
export async function uninstalledPackages(source: string): Promise<string[]> {
  type Packages = NonNullable<z.infer<typeof lockPackages>["packages"]>
  const read = (path: string): Promise<Packages> => readFile(join(source, path), "utf8").then((text) => lockPackages.parse(JSON.parse(text)).packages ?? {})
  const wanted = await read("package-lock.json").catch(() => null)
  if (!wanted) return []
  const installed = await read(HIDDEN_LOCKFILE).catch((): Packages => ({}))
  const missing = new Set<string>()
  for (const [path, entry] of Object.entries(wanted)) {
    const at = path.lastIndexOf("node_modules/")
    if (at === -1 || entry.optional || entry.devOptional || entry.peer) continue
    const held = installed[path]
    if (!held || held.version !== entry.version) missing.add(path.slice(at + "node_modules/".length))
  }
  return [...missing]
}

/** The packages as the build's state carries them: a count and the first few names. */
export const missingDependencies = (names: string[]): MissingDependencies => ({ count: names.length, names: names.slice(0, NAMED) })

/** package.json and package-lock.json files in the checkout with changes Git hasn't committed, new ones included. */
async function changedManifests(git: Git, source: string): Promise<string[]> {
  // Each entry is `XY path`; read whole, since a trimmed first entry loses its leading status column.
  const { stdout } = await git.run({
    cwd: source,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "package-lock.json", ":(glob)**/package.json"],
    read: true,
    timeoutMs: 10_000,
  })
  return stdout.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.slice(3))
}

/** `cd '/path/to/mako' && npm install`, ready to paste. */
const byHand = (source: string) => `cd '${source.replaceAll("'", `'\\''`)}' && npm install`

/** Why the install didn't happen, and the command that does it by hand, said apart so it can be copied whole. */
export class DependencyInstallError extends Error {
  readonly command: string
  constructor(message: string, source: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DependencyInstallError"
    this.command = byHand(source)
  }
}

export interface InstallDependencyOptions {
  /** Runs npm with these arguments in the checkout, and stops it when the signal aborts. */
  run: (args: string[], signal: AbortSignal) => Promise<void>
  /** Called just before npm starts. */
  installing?: () => void
  signal?: AbortSignal
  /** `DEPENDENCY_INSTALL_TIMEOUT_MS` unless a test shortens it. */
  timeoutMs?: number
}

/**
 * Install `missing` (from `uninstalledPackages`) into the checkout with npm
 * install. Refused while package.json or package-lock.json has uncommitted
 * changes: those are the person's, mid-edit, and an install would act on
 * them. Every failure says what to run by hand.
 */
export async function installDependencies(git: Git, source: string, missing: string[], options: InstallDependencyOptions): Promise<void> {
  const needs = missingDependenciesText(missingDependencies(missing))
  const changed = await changedManifests(git, source)
  if (changed.length) {
    const files = changed.length > 2 ? `${changed.slice(0, 2).join(", ")} and ${changed.length - 2} more` : changed.join(" and ")
    throw new DependencyInstallError(`${needs} The checkout has uncommitted changes to ${files}, so Mako won't run npm install there for you. Commit or discard them, or run npm install yourself, then build again.`, source)
  }
  options.installing?.()
  const limit = options.timeoutMs ?? DEPENDENCY_INSTALL_TIMEOUT_MS
  const timeout = AbortSignal.timeout(limit)
  try {
    await options.run(DEPENDENCY_INSTALL_ARGS, options.signal ? AbortSignal.any([options.signal, timeout]) : timeout)
  } catch (error) {
    options.signal?.throwIfAborted()
    const reason = timeout.aborted
      ? `npm install didn't finish within ${limit >= 60_000 ? `${Math.round(limit / 60_000)} minutes` : `${Math.round(limit / 1000)} seconds`}, so Mako stopped it.`
      : error instanceof Error ? error.message : String(error)
    throw new DependencyInstallError(`${reason} Run npm install yourself to see the whole error, then build again.`, source, { cause: error })
  }
  const still = await uninstalledPackages(source)
  if (still.length)
    throw new DependencyInstallError(`npm install finished, but ${missingDependenciesText(missingDependencies(still))} package.json and package-lock.json may disagree. Run npm install yourself to see why, then build again.`, source)
}
