import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { UncommittedChanges } from "../contracts/app-lifecycle.js"
import { PERFORMANCE_VERDICT_VARIABLE } from "../contracts/performance-verdict.js"
import { BUILD_UNCOMMITTED_VARIABLE } from "./local-update-source.js"

/**
 * What an update checks before it packages, and the environment it checks
 * in. Only what protects the person's install: that it builds, starts,
 * shuts down and keeps their data (`test:application`), loads in a packaged
 * app (`test:renderer-assets`), and isn't grossly slower than the code
 * before it (`test:update-performance`). Lint, typecheck and the whole
 * performance suite are CI's: they gate every change before it merges.
 *
 * CI runs this same list in this same environment (`ci-update-checks.ts`,
 * through `LocalUpdates` itself), because an update once failed on a test
 * that broke only under the variable the updater sets for its performance
 * check, and nothing else ever set it.
 *
 * So a commit whose `update-checks` passed on the default branch has passed
 * all of this already (`readCi`), the performance check on a quiet runner
 * rather than a Mac at load 26. An update of one, clean from its upstream,
 * runs `machine` alone: what only this Mac can tell. A build with local
 * changes, or a commit CI hasn't vouched for, runs everything.
 */
export const UPDATE_CHECKS = {
  /** Alone first: everything after reads its output. */
  compile: "build",
  /** Together, once it's built. */
  checks: ["test:application", "test:renderer-assets"],
  /** Alone, last: a timing that shares the Mac with the other checks measures them too. */
  performance: "test:update-performance",
  /** What an update of a commit CI passed still runs: a real host and this Mac's Electron, all of it among `checks`. */
  machine: "test:update-machine",
} as const

/** What a checkout from before `test:update-performance` checks its performance with. */
export const LEGACY_PERFORMANCE = "test:performance"

/**
 * A file naming, one per line, the files the build differs in from the
 * installed app; the performance check skips a benchmark none of whose
 * inputs is among them. Unset, every benchmark runs.
 */
export const UPDATE_CHANGED_VARIABLE = "MAKO_UPDATE_CHANGED"

/**
 * How much slower than the code before it a row may measure under the
 * updater before it fails: a gross regression, not CI's 25%. CI's
 * `performance` job holds every change to 25% on its own runner; on a busy
 * Mac, a finer line than this fails on noise.
 */
export const PERFORMANCE_ALLOWED_VARIABLE = "MAKO_PERFORMANCE_ALLOWED"
export const UPDATE_PERFORMANCE_ALLOWED = 1.5

/** The only variables a build inherits from the host: none of the host's own, or a terminal's, reach the checks. */
const INHERITED = ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL"]

export function updaterInherited(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(INHERITED.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]))
}

/** What every check of a build sees beyond the variables it inherits: the build's identity and source. */
export function updateEnvironment(inherited: NodeJS.ProcessEnv, build: { identity: string; revision: string; uncommitted: UncommittedChanges; source?: string; changed?: string }): NodeJS.ProcessEnv {
  return {
    ...inherited,
    MAKO_LOCAL_SIGNING_IDENTITY: build.identity,
    MAKO_BUILD_REVISION: build.revision,
    MAKO_BUILD_DIRTY: build.uncommitted.count ? "1" : "0",
    [BUILD_UNCOMMITTED_VARIABLE]: JSON.stringify(build.uncommitted),
    // A copy without history; a performance row over budget is measured beside a commit exported from here.
    ...build.source && { MAKO_BUILD_SOURCE: build.source },
    ...build.changed && { [UPDATE_CHANGED_VARIABLE]: build.changed },
  }
}

/** What the performance check alone sees on top: where its verdicts go, and the gross line. */
export function performanceEnvironment(verdicts: string): NodeJS.ProcessEnv {
  return { [PERFORMANCE_VERDICT_VARIABLE]: verdicts, [PERFORMANCE_ALLOWED_VARIABLE]: String(UPDATE_PERFORMANCE_ALLOWED) }
}

/** Write `UPDATE_CHANGED_VARIABLE`'s file into `folder`, answering its path. */
export async function writeChanged(folder: string, paths: string[]): Promise<string> {
  const file = join(folder, "changed.txt")
  await writeFile(file, paths.map((path) => `${path}\n`).join(""), { mode: 0o600 })
  return file
}

const scripts = z.object({ scripts: z.record(z.string(), z.string()) })

/**
 * What the checkout carries: its performance script, its own
 * `test:update-performance` else what it had before, and its machine checks,
 * which a commit from before them hasn't got: it runs everything.
 */
export async function checkScripts(checkout: string): Promise<{ performance: string; machine: boolean }> {
  const listed = scripts.parse(JSON.parse(await readFile(join(checkout, "package.json"), "utf8"))).scripts
  return { performance: UPDATE_CHECKS.performance in listed ? UPDATE_CHECKS.performance : LEGACY_PERFORMANCE, machine: UPDATE_CHECKS.machine in listed }
}
