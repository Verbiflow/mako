import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { stepsCommand, stepsOf } from "../electron/check-steps.js"
import { ThreadIdSchema } from "../electron/contracts/thread-identity.js"
import { AppKeySchema, type ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { environmentTools } from "../electron/environment-tools.js"
import { portListening } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { readVersion, recipePath, RecipeSchema, recipeVersions, type Recipe } from "../electron/thread-recipe.js"
import type { JsonValue } from "../electron/codex-app-json.js"

/**
 * A check of named steps on real runs: each step timed and reported on its
 * own, a failure naming its step with that step's output, later steps not
 * run, parallel steps at once, a rerun of some steps keeping the others'
 * last results, waiting on a run under way, the desk's view of each step,
 * and a verify of steps proving a draft step by step.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-check-steps-")))
const project = join(root, "app")
mkdirSync(project)
const processes = new ThreadProcesses({ root: join(root, "records"), listening: portListening })
const recipesRoot = join(root, "recipes")
const id = ThreadIdSchema.parse(randomUUID())
const dataDir = join(root, "data")
mkdirSync(dataDir)
// No process listens here; quick checks start nothing.
const environment: ThreadEnvironment = { thread: id, app: AppKeySchema.parse(id), host: "steps.thread.localhost", port: 20025, ports: 1, dataDir }
const toolsFor = (settleMs = 10_000) => environmentTools({
  cwd: () => project,
  environment: async () => environment,
  launchedWith: () => undefined,
  folder: async () => ({ app: environment.app, checkout: project, project: "app", root: project, environment }),
  processes,
  recipesRoot,
  settleMs,
})
const tools = toolsFor()
const conversation = "conversation"
/** Recipes as an agent writes them: JSON, parsed here as recipe_save does. */
const recipe = (checks: JsonValue, extra: Partial<Recipe> = {}) => RecipeSchema.parse({ values: {}, processes: {}, checks, ...extra })
const seconds = "[\\d.]+ s"

try {
  // The schema: a plain command stays one; steps need their own names; a wrong shape says what fits.
  assert.equal(recipe({ quick: "npm test" }).checks.quick, "npm test")
  assert.deepEqual(recipe({ quick: [{ name: "lint", command: "npm run lint" }] }).checks.quick, [{ name: "lint", command: "npm run lint" }])
  const refusal = (checks: JsonValue) => {
    const parsed = RecipeSchema.safeParse({ values: {}, processes: {}, checks })
    assert.ok(!parsed.success)
    return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
  }
  assert.match(refusal({ quick: [{ name: "Lint", command: "x" }] }), /^checks\.quick\.0\.name: a step name is lowercase letters, digits and hyphens, such as typecheck$/)
  assert.match(refusal({ quick: [{ name: "lint", command: "x" }, { name: "lint", command: "y" }] }), /lint names two steps; each step needs its own name/)
  assert.match(refusal({ quick: 3 }), /^checks\.quick: a command, or a list of named steps such as \[\{ "name": "lint", "command": "npm run lint" \}\]$/)
  assert.ok(refusal({ quick: [] }).startsWith("checks.quick"))
  const script = stepsCommand([{ name: "a", command: "echo 'quoted'" }, { name: "b", command: "true", parallel: true }])
  assert.deepEqual(stepsOf(script), [{ name: "a", command: "echo 'quoted'" }, { name: "b", command: "true", parallel: true }], "a run of steps says which it ran")
  assert.equal(stepsOf("npm test"), undefined)

  // A check of one command reads as it always has.
  await tools.save(conversation, recipe({ quick: "echo fine" }), "One command")
  assert.match(await tools.check(conversation, "quick"), new RegExp(`^The quick check passed in ${seconds}\\.$`))
  await assert.rejects(tools.check(conversation, "quick", undefined, ["lint"]), /The quick check is one command \(echo fine\), with no named steps to choose from; call it without steps\./)

  // Every step passes: each is timed.
  const typecheck = { name: "typecheck", command: "echo types fine" }
  const failingLint = { name: "lint", command: "echo noise; echo src/a.ts: unused variable >&2; exit 2" }
  const unit = { name: "unit", command: "echo units fine" }
  await tools.save(conversation, recipe({ quick: [typecheck, { name: "lint", command: "echo lint fine" }] }), "Steps")
  assert.match(await tools.check(conversation, "quick"), new RegExp(`^The quick check passed in ${seconds}: typecheck passed in ${seconds}; lint passed in ${seconds}\\.$`))

  // A failed step is named with its command, its exit code and its own output; the steps after it don't run.
  await tools.save(conversation, recipe({ quick: [typecheck, failingLint, unit] }), "Lint fails")
  const failed = await tools.check(conversation, "quick")
  assert.match(failed, new RegExp(`^The quick check failed in ${seconds}: typecheck passed in ${seconds}; lint failed \\(exit 2\\) in ${seconds}; unit didn't run, since a step before it failed\\.\\n\\n`))
  assert.match(failed, new RegExp(`\\n\\nlint failed \\(exit 2\\) in ${seconds}\\. It ran: echo noise; echo src/a\\.ts: unused variable >&2; exit 2\\n\\nnoise\\nsrc/a\\.ts: unused variable\\n\\n`))
  assert.doesNotMatch(failed, /types fine/, "only the failed step's output")
  assert.match(failed, /\n\nOnce you've fixed it, app_check with steps \["lint"\] runs only that step\.$/)
  assert.equal(await tools.logs(conversation, { check: "quick", step: "lint" }, 10), "noise\nsrc/a.ts: unused variable")
  assert.match(await tools.logs(conversation, { check: "quick" }, 20), /^\[typecheck\] echo types fine\ntypes fine\n\[typecheck\] exit 0\n\n\[lint\] /, "the whole run's output has every step, marked")

  // The desk and app_status see each step's last result.
  const view = await tools.desk!.view(project)
  assert.ok(view.kind === "ready")
  const quick = view.checks.find((check) => check.tier === "quick")
  assert.equal(quick?.state, "failed")
  assert.deepEqual(quick?.steps?.map((step) => [step.name, step.state, step.ms !== undefined]), [["typecheck", "passed", true], ["lint", "failed", true], ["unit", "never", false]])
  assert.equal(quick?.command, "typecheck: echo types fine; lint: echo noise; echo src/a.ts: unused variable >&2; exit 2; unit: echo units fine")
  const output = await tools.desk!.output(project, "check:quick:lint")
  assert.equal(output.text, "noise\nsrc/a.ts: unused variable\n")
  assert.match(parseYaml(await tools.status(conversation)).checks.quick, new RegExp(`^failed [\\d:]+, \\d+ s ago: typecheck passed in ${seconds}; lint failed \\(exit 2\\) in ${seconds}; unit not run yet$`))

  // A rerun of only the fixed step keeps the others' last results; a step never run since says so.
  await tools.save(conversation, recipe({ quick: [typecheck, { name: "lint", command: "echo lint fixed" }, unit] }), "Lint fixed")
  await assert.rejects(tools.check(conversation, "quick", undefined, ["lnt"]), /The quick check has no step named lnt; its steps are typecheck, lint, unit\./)
  const only = await tools.check(conversation, "quick", undefined, ["lint"])
  assert.match(only, new RegExp(`^The quick check \\(only lint\\) passed in ${seconds}: lint passed in ${seconds}\\.\\n\\nNot in this run, with their last results: typecheck passed in ${seconds} \\([\\d:]+, \\d+ s ago\\); unit not run yet\\.$`))
  const afterOnly = await tools.desk!.view(project)
  assert.ok(afterOnly.kind === "ready")
  assert.deepEqual(afterOnly.checks[0]?.steps?.map((step) => step.state), ["passed", "passed", "never"], "the check passes once every step has")
  assert.equal(afterOnly.checks[0]?.state, "never")
  assert.match(parseYaml(await tools.status(conversation)).checks.quick, /^not every step has run yet: /)
  assert.match(await tools.check(conversation, "quick", undefined, ["unit"]), /^The quick check \(only unit\) passed/)
  const whole = await tools.desk!.view(project)
  assert.equal(whole.kind === "ready" && whole.checks[0]?.state, "passed")

  // A step whose command changed isn't counted as passed by its old result.
  await tools.save(conversation, recipe({ quick: [{ name: "typecheck", command: "echo types changed" }, { name: "lint", command: "echo lint fixed" }, unit] }), "Typecheck changed")
  const changed = await tools.desk!.view(project)
  assert.deepEqual(changed.kind === "ready" && changed.checks[0]?.steps?.map((step) => step.state), ["never", "passed", "passed"])

  // Parallel steps run at once; a failure among them ends the run once they've all finished.
  await tools.save(conversation, recipe({ quick: [
    { name: "one", command: "sleep 1; echo one", parallel: true },
    { name: "two", command: "sleep 1; echo two; exit 4", parallel: true },
    { name: "three", command: "sleep 1; echo three", parallel: true },
    { name: "after", command: "echo after" },
  ] }), "Parallel")
  const began = Date.now()
  const parallel = await tools.check(conversation, "quick")
  assert.ok(Date.now() - began < 2_500, `three one-second steps ran at once (${Date.now() - began} ms)`)
  assert.match(parallel, new RegExp(`^The quick check failed in ${seconds}: one passed in ${seconds}; two failed \\(exit 4\\) in ${seconds}; three passed in ${seconds}; after didn't run, since a step before it failed\\.`))

  // A run that outlasts the call keeps going; the next call waits on that same run.
  const quickly = toolsFor(300)
  await quickly.save(conversation, recipe({ quick: [{ name: "fast", command: "echo fast" }, { name: "slow", command: "sleep 2; echo slow" }] }), "Slow step")
  const still = await quickly.check(conversation, "quick")
  assert.match(still, new RegExp(`^The quick check is still running, ${seconds} in, and keeps going: fast (passed in ${seconds}|running, ${seconds} in|waiting for the steps before it); slow (running, ${seconds} in|waiting for the steps before it)\\. Your next app_check with tier "quick" waits for this same run`))
  assert.match(still, /app_logs with check "quick" shows its output so far, and with a step too, that step's alone\.$/)
  let joined = still
  for (let tries = 0; tries < 20 && joined.includes("still running"); tries++) joined = await quickly.check(conversation, "quick")
  assert.match(joined, new RegExp(`^The quick check passed in ${seconds}: fast passed in ${seconds}; slow passed in ${seconds}\\.(\\nThis is the run your last app_check left running\\.|$)`))

  // A verify of steps proves a draft step by step, and the proof keeps each.
  await tools.save(conversation, recipe({ quick: "true" }, { verify: { run: [{ name: "smoke", command: "echo smoke" }, { name: "api", command: "echo api" }] } }), "Verify in steps")
  const published = await tools.publish(conversation)
  const version = Number(/^Published version (\d+) in /.exec(published)?.[1])
  assert.ok(version > 0, published)
  assert.match(published, new RegExp(`verify: smoke passed in ${seconds}, verify: api passed in ${seconds}`))
  const record = await readVersion(await recipePath(recipesRoot, project), version)
  assert.deepEqual(record?.proof?.steps.map((step) => [step.name, step.passed, step.command]), [["verify: smoke", true, "echo smoke"], ["verify: api", true, "echo api"]])
  await tools.save(conversation, recipe({ quick: "true" }, { verify: { run: [{ name: "smoke", command: "echo smoke" }, { name: "api", command: "echo api down; exit 7" }] } }), "Verify fails")
  const refused = await tools.publish(conversation)
  assert.match(refused, new RegExp(`^Draft \\d+ wasn't published: verify failed in ${seconds}: smoke passed in ${seconds}; api failed \\(exit 7\\) in ${seconds}\\.\\n\\napi failed \\(exit 7\\) in ${seconds}\\. It ran: echo api down; exit 7\\n\\napi down\\n\\nIt stays this Thread's draft`))
  assert.ok(recipeVersions(await recipePath(recipesRoot, project)))

  console.log("check steps: each step timed and named; a failure gives its step's own output and skips the rest; parallel steps run at once; a rerun of some keeps the others' results; a changed step isn't passed by its old result; waiting joins the run under way; verify steps prove a draft step by step")
} finally {
  await processes.stop(environment.app).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
