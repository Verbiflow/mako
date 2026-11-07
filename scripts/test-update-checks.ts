import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { LEGACY_PERFORMANCE, performanceEnvironment, UPDATE_CHECKS, UPDATE_PERFORMANCE_ALLOWED, updateEnvironment, updaterInherited } from "@mako/host/application/local-update-checks"
import { githubRepository, readCi, type GitHubApi } from "@mako/host/application/local-update-ci"
import { allowedRegression } from "./perf-reference"
import { COMPARISONS, inputs, touches } from "./test-update-performance"

/**
 * What an update checks and in what environment (`local-update-checks.ts`):
 * every script it runs exists here, the performance check is the update's
 * own and not `test:performance`, only the variables the updater names
 * reach a check, and a comparison is skipped only when none of the files it
 * imports or reads changed.
 */

const root = join(import.meta.dirname, "..")
const scripts = z.object({ scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).scripts
for (const script of [UPDATE_CHECKS.compile, ...UPDATE_CHECKS.checks, UPDATE_CHECKS.performance, UPDATE_CHECKS.machine, LEGACY_PERFORMANCE]) assert.ok(scripts[script], `package.json has ${script}`)
assert.doesNotMatch(scripts[UPDATE_CHECKS.performance]!, /test-perf-reference|test:performance/, "the update's performance check runs no unit test of the harness")

// The machine checks are a part of what CI runs, never a check of their own, and cost seconds: every step is one of its.
const steps = (name: string): string[] => scripts[name]!.split(" && ").flatMap((step) => /^npm run -s (\S+)$/.exec(step)?.[1] ? steps(/^npm run -s (\S+)$/.exec(step)![1]!) : [step.replace(/^tsx /, "npx tsx ")])
const inCi = new Set(UPDATE_CHECKS.checks.flatMap(steps))
assert.ok(steps(UPDATE_CHECKS.machine).length >= 4)
for (const step of steps(UPDATE_CHECKS.machine)) assert.ok(inCi.has(step), `a machine check CI doesn't run: ${step}`)
assert.doesNotMatch(scripts[UPDATE_CHECKS.machine]!, /test:update-source|test-application-ui|test:update-performance/, "what takes minutes and depends on no Mac stays CI's")

// What CI vouches for: this commit on the default branch as GitHub says it is, its push, the newest run whole, and the job that runs these checks.
const commit = "c".repeat(40)
const run = { id: 7, run_number: 70, run_attempt: 1, head_sha: commit, head_branch: "main", event: "push", status: "completed", conclusion: "success", html_url: "https://example.invalid/7" }
const job = { name: "update-checks", run_attempt: 1, status: "completed", conclusion: "success" }
const answers = (runs: object[], jobs: object[] = [job], server = "main"): GitHubApi => async (path) =>
  JSON.stringify(path.includes("/jobs") ? { total_count: jobs.length, jobs } : path.includes("/runs") ? { total_count: runs.length, workflow_runs: runs } : { default_branch: server })
const older = { ...run, id: 6, run_number: 69 }
assert.deepEqual(await readCi(answers([run]), "o/r", "main", commit), { passed: true, run: run.html_url })
assert.equal((await readCi(answers([run, older]), "o/r", "main", commit)).passed, true, "the newest of two green runs vouches")
assert.equal((await readCi(answers([older, { ...run, conclusion: "success" }]), "o/r", "main", commit)).passed, true, "whichever order they're listed in")
const redFirst = { ...run, conclusion: "failure" }
for (const [label, runs, jobs] of [
  ["no run yet", [], undefined],
  ["a run still going", [{ ...run, status: "in_progress", conclusion: null }], undefined],
  ["a run queued", [{ ...run, status: "queued", conclusion: null }], undefined],
  ["a run that says it's going and it succeeded", [{ ...run, status: "in_progress" }], undefined],
  ["a run that says it finished with no conclusion", [{ ...run, conclusion: null }], undefined],
  ["a failed run", [redFirst], undefined],
  ["a cancelled run", [{ ...run, conclusion: "cancelled" }], undefined],
  ["a newer failed run over an older green one", [redFirst, older], undefined],
  ["the same, listed the other way", [older, redFirst], undefined],
  ["a newer run still going over an older green one", [{ ...run, status: "in_progress", conclusion: null }, older], undefined],
  ["another commit", [{ ...run, head_sha: "d".repeat(40) }], undefined],
  ["a pull request's run", [{ ...run, event: "pull_request" }], undefined],
  ["another branch", [{ ...run, head_branch: "feature" }], undefined],
  ["update-checks failed", [run], [{ ...job, conclusion: "failure" }]],
  ["update-checks skipped", [run], [{ ...job, conclusion: "skipped" }]],
  ["update-checks still going", [run], [{ ...job, status: "in_progress", conclusion: null }]],
  ["update-checks going and successful", [run], [{ ...job, status: "in_progress" }]],
  ["update-checks of an earlier attempt", [{ ...run, run_attempt: 2 }], [job]],
  ["one of two update-checks failed", [run], [job, { ...job, conclusion: "failure" }]],
  ["no update-checks at all", [run], [{ ...job, name: "checks" }]],
] as const) assert.equal((await readCi(answers([...runs], jobs && [...jobs]), "o/r", "main", commit)).passed, false, `${label} vouches for nothing`)
assert.equal((await readCi(answers([run], [job], "trunk"), "o/r", "main", commit)).passed, false, "a branch the server no longer calls its default vouches for nothing, whatever origin/HEAD says")
const partOfTheRuns: GitHubApi = async (path) => (path.includes("/jobs") ? JSON.stringify({ total_count: 1, jobs: [job] }) : path.includes("/runs") ? JSON.stringify({ total_count: 101, workflow_runs: [run] }) : JSON.stringify({ default_branch: "main" }))
assert.equal((await readCi(partOfTheRuns, "o/r", "main", commit)).passed, false, "a list cut short may hide a newer run")
const partOfTheJobs: GitHubApi = async (path) => (path.includes("/jobs") ? JSON.stringify({ total_count: 101, jobs: [job] }) : path.includes("/runs") ? JSON.stringify({ total_count: 1, workflow_runs: [run] }) : JSON.stringify({ default_branch: "main" }))
assert.equal((await readCi(partOfTheJobs, "o/r", "main", commit)).passed, false, "and a job list cut short may hide a failed job")
assert.equal((await readCi(async () => { throw new Error("gh: command not found") }, "o/r", "main", commit)).passed, false, "no gh is no answer")
assert.equal((await readCi(async () => "<html>", "o/r", "main", commit)).passed, false, "nor is an answer that isn't one")
for (const url of ["https://github.com/Verbiflow/mako.git", "https://github.com/Verbiflow/mako", "git@github.com:Verbiflow/mako.git", "ssh://git@github.com/Verbiflow/mako.git", "https://github.com/Verbiflow/mako.git\n"])
  assert.equal(githubRepository(url), "Verbiflow/mako", url)
for (const url of ["/tmp/remote.git", "https://gitlab.com/Verbiflow/mako.git", "https://github.com.example.com/Verbiflow/mako.git", "https://example.com/github.com/Verbiflow/mako.git"])
  assert.equal(githubRepository(url), null, url)

// The host's own variables (a terminal's, Electron's, a test's) never reach a check.
const inherited = updaterInherited({ HOME: "/h", PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", MAKO_PERFORMANCE_VERDICT: "/leak", NODE_OPTIONS: "--inspect" })
assert.deepEqual(inherited, { HOME: "/h", PATH: "/bin" })
const env = updateEnvironment(inherited, { identity: "A".repeat(40), revision: "f".repeat(40), uncommitted: { count: 0, files: [] }, source: "/src", changed: "/changed.txt" })
assert.equal(env.MAKO_PERFORMANCE_VERDICT, undefined, "the verdict file is the performance check's alone")
assert.deepEqual(Object.keys(env).sort(), ["HOME", "MAKO_BUILD_DIRTY", "MAKO_BUILD_REVISION", "MAKO_BUILD_SOURCE", "MAKO_BUILD_UNCOMMITTED", "MAKO_LOCAL_SIGNING_IDENTITY", "MAKO_UPDATE_CHANGED", "PATH"])
assert.deepEqual(performanceEnvironment("/v.jsonl"), { MAKO_PERFORMANCE_VERDICT: "/v.jsonl", MAKO_PERFORMANCE_ALLOWED: String(UPDATE_PERFORMANCE_ALLOWED) })
assert.equal(allowedRegression({ MAKO_PERFORMANCE_ALLOWED: String(UPDATE_PERFORMANCE_ALLOWED) }), UPDATE_PERFORMANCE_ALLOWED, "the comparisons read the updater's gross line")
assert.equal(allowedRegression({}), 1.25, "and CI's 25% without it")
assert.equal(allowedRegression({ MAKO_PERFORMANCE_ALLOWED: "0.5" }), 1.25, "a line below 1 is no line")

// Each comparison's inputs: its imports followed into the workspace packages' sources, and what it reads.
const decoders = await inputs(COMPARISONS.find((comparison) => comparison.name === "perf:decoders")!)
assert.ok(decoders.includes("scripts/perf-decoders.ts"))
assert.ok(decoders.some((path) => path.startsWith("packages/sessions/src/")), "a workspace package is read from its source, not its dist")
assert.ok(!decoders.some((path) => path.includes("/dist/")))
assert.ok(decoders.includes("scripts/fixtures/native-decoding/") && decoders.includes("package-lock.json"))
assert.ok(!decoders.some((path) => path.startsWith("src/components/settings/")), "the window's settings are no decoder's input")
assert.deepEqual(touches(decoders, ["docs/notes.md", "src/components/settings/updates-section.tsx"]), [], "a change to docs and Settings skips it")
assert.deepEqual(touches(decoders, ["scripts/fixtures/native-decoding/codex/pairs/x/pair.json", "docs/notes.md"]), ["scripts/fixtures/native-decoding/codex/pairs/x/pair.json"], "a fixture inside a folder it reads runs it")
assert.deepEqual(touches(decoders, ["package-lock.json"]), ["package-lock.json"], "a dependency change runs it")

console.log(`Update checks: ${[UPDATE_CHECKS.compile, ...UPDATE_CHECKS.checks, UPDATE_CHECKS.performance].join(", ")}, each in package.json; only the updater's named variables reach them, the verdict file and the ${UPDATE_PERFORMANCE_ALLOWED}× line the performance check's alone; a comparison is skipped only when none of its ${decoders.length} inputs changed`)
