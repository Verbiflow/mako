import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { movePin } from "./lib/bump-records.ts"

/**
 * Puts the day's harness bumps on one tree, so the pull requests they open never conflict with each other.
 *
 *   npx tsx scripts/assemble-harness-bumps.ts <bump> [<bump> …] --summary <file>
 *
 * Each `<bump>` is a folder one run of `bump-harness-versions.ts --write` left (the workflow's artifact):
 * `change.patch` (its tree against the base, `git diff --binary`), `outcome.json` (`--outcome`) and `summary.md`
 * (`--summary`). Each patch is applied but for what two bumps of one day both write (`GENERATED`): the generated
 * files and the lockfile are written again here from the declarations and records the patches carry, and each
 * bundled package's pins are moved in place (`movePin`), so the order the bumps are applied in never matters and
 * none conflicts with another. Then the checks a pull request runs on them run once on the whole: a bump that
 * passed alone and fails beside another says so here. Committing, pushing and opening the pull request are the
 * workflow's (`.github/workflows/harness-versions.yml`).
 */

const REPO = join(import.meta.dirname, "..")

/** What every bump writes and two of a day would conflict on: written again here, never applied. */
export const GENERATED = [
  "docs/adding-a-harness.md",
  "docs/harness-concepts.md",
  "src/dev/harness-descriptors.ts",
  "src/dev/harness-faces.ts",
  "package-lock.json",
  "package.json",
  "packages/*/package.json",
]

const Outcome = z.object({
  harness: z.string(),
  version: z.string(),
  tested: z.string(),
  state: z.enum(["finished", "judgement", "broken"]),
  pins: z.array(z.object({ package: z.string(), version: z.string() })).default([]),
}).loose()

interface Step {
  name: string
  ok: boolean
  detail?: string
}

function run(name: string, command: string, args: string[], steps: Step[]): boolean {
  console.log(`\n$ ${[command, ...args].join(" ")}`)
  const result = spawnSync(command, args, { cwd: REPO, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  process.stderr.write(result.stderr ?? "")
  const ok = result.status === 0
  const said = (result.stderr ?? "").split("\n").map((line) => line.trim()).filter((line) => /^(?:\w*Error\b.*?:|AssertionError|✗ |error: )/.test(line))
  steps.push({ name, ok, ...!ok && { detail: (said.slice(0, 4).join(" · ") || result.error?.message || `exited with ${result.status ?? result.signal}`).slice(0, 600) } })
  return ok
}

/** Every package.json of the workspace: the root's and each package's. */
function manifests(): string[] {
  const packages = join(REPO, "packages")
  return [join(REPO, "package.json"), ...readdirSync(packages).map((name) => join(packages, name, "package.json")).filter((file) => existsSync(file))]
}

const { values: options, positionals: bumps } = parseArgs({ allowPositionals: true, options: { summary: { type: "string" } } })
if (!bumps.length) throw new Error("name the folders of the bumps to put together")

const steps: Step[] = []
const outcomes = bumps.map((folder) => ({ folder, outcome: Outcome.parse(JSON.parse(readFileSync(join(folder, "outcome.json"), "utf8"))) }))
  // One order whatever order the artifacts came in.
  .sort((left, right) => left.outcome.harness.localeCompare(right.outcome.harness))
for (const { folder, outcome } of outcomes) {
  const patch = join(folder, "change.patch")
  const exclude = GENERATED.map((path) => `--exclude=${path}`)
  if (readFileSync(patch).length) run(`${outcome.harness} ${outcome.version}'s change applied`, "git", ["apply", "--binary", "--whitespace=nowarn", ...exclude, patch], steps)
  for (const pin of outcome.pins) {
    const moved = manifests().filter((file) => movePin(file, pin.package, pin.version))
    steps.push({ name: `${pin.package} pinned at ${pin.version}`, ok: moved.length > 0, ...!moved.length && { detail: "no package.json pins it exactly" } })
  }
}
// The lockfile from the pins, the generated files from the declarations and records, then the checks on the whole.
run("npm install", "npm", ["install", "--no-audit", "--no-fund"], steps)
run("@mako/sessions built", "npm", ["run", "-s", "build", "--workspace", "@mako/sessions"], steps)
run("harness:checklist", "npm", ["run", "harness:checklist"], steps)
run("harness:concepts", "npm", ["run", "harness:concepts"], steps)
run("harness:descriptors", "npm", ["run", "harness:descriptors"], steps)
run("version records agree with tested", "npx", ["tsx", "scripts/test-harness-definitions.ts"], steps)
run("vocabulary declares every recorded tool", "npx", ["tsx", "scripts/test-native-tools.ts"], steps)
run("concepts match the declarations", "npx", ["tsx", "scripts/test-harness-concepts.ts"], steps)
run("decoders and pairs", "npm", ["run", "test:decoders"], steps)

const together = outcomes.map(({ outcome }) => `${outcome.harness} ${outcome.version}`).join(", ")
const lines = [
  outcomes.length > 1 ? `Moves ${together}: the day's releases, put together on one branch.` : `Moves ${together}.`,
  "",
  `**${steps.every((step) => step.ok) ? "Together they pass every check the bumps ran alone." : "Together they fail a check; see the failed rows below."}**`,
  "",
  "| Put together | Result |",
  "| --- | --- |",
  ...steps.map((step) => `| ${step.name} | ${step.ok ? "passed" : `**failed**${step.detail ? `: ${step.detail.replaceAll("|", "\\|")}` : ""}`} |`),
  ...outcomes.flatMap(({ folder, outcome }) => ["", `## ${outcome.harness} ${outcome.version}`, "", readFileSync(join(folder, "summary.md"), "utf8").trim()]),
]
if (options.summary) writeFileSync(options.summary, `${lines.join("\n")}\n`)
for (const step of steps) console.log(`${step.ok ? "ok    " : "FAILED"} ${step.name}${step.detail ? ` · ${step.detail}` : ""}`)
process.exitCode = steps.every((step) => step.ok) ? 0 : 1
