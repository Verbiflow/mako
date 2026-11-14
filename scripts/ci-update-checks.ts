/**
 * The local updater's checks, at review: `runUpdateChecks` from
 * `local-updates.ts`, the function Settings › Updates runs, on this tree, in
 * the environment it builds (`updateEnvironment`, `performanceEnvironment`
 * and only the variables `updaterInherited` lets through). An update once
 * failed three times on a test that broke only under the updater's verdict
 * variable, which nothing at review ever set; a check that fails only the
 * updater's way now fails here first.
 *
 * Like the updater, it names the files this change touches against its
 * base (`MAKO_UPDATE_CHANGED`), so a comparison none of whose inputs changed
 * is skipped here as it would be there. Each step's time and the outcome go
 * to the job's summary.
 *
 *   npx tsx scripts/ci-update-checks.ts [--base <commit>]     what CI runs; the base defaults to HEAD^1
 */
import { execFileSync } from "node:child_process"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { checkScripts, updateEnvironment, updaterInherited, writeChanged } from "@mako/host/application/local-update-checks"
import { runUpdateChecks } from "@mako/host/application/local-updates"
import { environmentForExecutable, resolveExecutable } from "@mako/host/base/executable"
import type { BuildPhase } from "@mako/host/contracts/app-lifecycle"

const root = dirname(import.meta.dirname)
const at = process.argv.indexOf("--base")
const base = at === -1 ? "HEAD^1" : process.argv[at + 1]
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const node = resolveExecutable("node")
const npm = resolveExecutable("npm")
if (!node || !npm) throw new Error("Node.js and npm are required")
const revision = git("rev-parse", "HEAD")
const folder = await mkdtemp(join(tmpdir(), "mako-update-checks-"))
const steps: [BuildPhase | "total", number][] = []
const began = Date.now()
let phaseAt = began
let current: BuildPhase | null = null
const phase = (next: BuildPhase) => {
  if (current) steps.push([current, Date.now() - phaseAt])
  current = next
  phaseAt = Date.now()
  console.log(`Update checks: ${next}`)
}
const summary = async (lines: string[]) => {
  console.log(lines.join("\n"))
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`)
}
let outcome = "passed"
try {
  const changed = base ? git("diff", "--name-only", "--no-renames", base, revision, "--").split("\n").filter(Boolean) : null
  const env = environmentForExecutable(node, {
    ...updateEnvironment(updaterInherited(process.env), {
      identity: "0".repeat(40),
      revision,
      uncommitted: { count: 0, files: [] },
      source: root,
      ...changed && { changed: await writeChanged(folder, changed) },
    }),
    // Where a check keeps what says why it failed (a host's logs when it was slow to stop), for the job's artifacts.
    ...process.env.MAKO_TEST_EVIDENCE && { MAKO_TEST_EVIDENCE: process.env.MAKO_TEST_EVIDENCE },
  })
  const scripts = await checkScripts(root)
  const unsure = await runUpdateChecks({ npm, checkout: root, env, folder, revision, performance: scripts.performance, phase })
  if (unsure) outcome = `passed, but the runner was too busy to settle ${unsure.rows.length} ${unsure.rows.length === 1 ? "timing" : "timings"} (${unsure.busy.join("; ")}): ${unsure.rows.join("; ")}`
} catch (error) {
  outcome = `failed: ${error instanceof Error ? error.message : String(error)}`
  process.exitCode = 1
} finally {
  if (current) steps.push([current, Date.now() - phaseAt])
  steps.push(["total", Date.now() - began])
  await summary([
    `### The local updater's checks at ${revision.slice(0, 8)}`,
    "",
    "| Step | Seconds |",
    "| --- | ---: |",
    ...steps.map(([step, ms]) => `| ${step} | ${Math.round(ms / 1000)} |`),
    "",
    `Outcome: ${outcome}`,
  ])
  await rm(folder, { recursive: true, force: true })
}
