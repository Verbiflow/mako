import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, readFile, readdir, realpath, utimes, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

/*
 * `build-control-runtime`'s cache, on three projects shaped like the control runtime's (`up` built inside `mid`'s
 * build as the host builds sessions, `down` reading `mid`'s declarations through its own `tsgo -b` as the client
 * does), replayed with PR #987's times: main's entry built just after a pull request's gate checked out, the gate's
 * build saved under the pull request's sources, and the performance job restoring that over a checkout made between
 * the two. `scripts/age-restored-build.mjs` run after each restore must make each build what a cold build of the
 * sources makes. Without it, the gate kept main's declaration of `mid` and passed, and the performance job failed on
 * a call the sources allow; the test asserts that too, so a compiler that stops trusting times shows up here as the
 * reason this step can go.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsgo = join(repo, "node_modules", ".bin", "tsgo")
const age = join(repo, "scripts", "age-restored-build.mjs")
// The real path: under macOS's /tmp link the compiler writes build info paths that leave the tree.
const scratch = await realpath(testScratch("mako-restored-build-"))

const options = {
  composite: true, declaration: true, outDir: "dist", rootDir: "src", strict: true, types: [],
  module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022",
}
const configs = {
  up: { compilerOptions: options, include: ["src/**/*.ts"] },
  mid: { compilerOptions: options, include: ["src/**/*.ts"], references: [{ path: "../up" }] },
  down: { compilerOptions: options, include: ["src/**/*.ts"], references: [{ path: "../mid" }] },
}
const up = `export const prefix = "agent"\n`
const base = {
  up,
  mid: `import { prefix } from "../../up/dist/index.js"\nexport function text(answer: string): string { return prefix + answer }\n`,
  down: `import { text } from "../../mid/dist/index.js"\nexport const line = text("done")\n`,
}
// The pull request: a declaration of `mid` that changes and a caller that needs the change; `up` as it was.
const change = {
  up,
  mid: `import { prefix } from "../../up/dist/index.js"\nexport function text(answer: string, tool?: string): string { return prefix + (tool ?? "") + answer }\n`,
  down: `import { text } from "../../mid/dist/index.js"\nexport const line = text("done", "agents_list")\n`,
}
const projects = ["up", "mid", "down"]

/** A checkout of `sources` whose files are all dated `at`, as actions/checkout dates them when it writes them. */
async function checkout(name, sources, at) {
  const root = join(scratch, name)
  for (const project of projects) {
    await mkdir(join(root, "packages", project, "src"), { recursive: true })
    await writeFile(join(root, "packages", project, "tsconfig.json"), JSON.stringify(configs[project]))
    await writeFile(join(root, "packages", project, "src", "index.ts"), sources[project])
    for (const file of ["tsconfig.json", "src/index.ts", "src", ""]) await utimes(join(root, "packages", project, file), at, at)
  }
  return root
}

/** `npm run build:control-runtime`'s shape: the last project's references built inside its own `tsgo -b`. */
function build(root) {
  for (const project of ["mid", "down"]) {
    const run = spawnSync(tsgo, ["-b", `packages/${project}`], { cwd: root, encoding: "utf8" })
    if (run.status !== 0) return { ok: false, output: run.stdout + run.stderr }
  }
  return { ok: true, output: "" }
}

/** A cache entry: every project's outputs and build info, kept with their times, as actions/cache's tar keeps them. */
async function save(root, name) {
  const entry = join(scratch, `${name}.entry`)
  for (const project of projects) {
    await cp(join(root, "packages", project, "dist"), join(entry, project, "dist"), { recursive: true, preserveTimestamps: true })
    await cp(join(root, "packages", project, "tsconfig.tsbuildinfo"), join(entry, project, "tsconfig.tsbuildinfo"), { preserveTimestamps: true })
  }
  return entry
}

async function restore(entry, root, aged) {
  for (const project of projects)
    await cp(join(entry, project), join(root, "packages", project), { recursive: true, preserveTimestamps: true })
  if (aged) {
    const run = spawnSync(process.execPath, [age, root], { encoding: "utf8" })
    assert.equal(run.status, 0, run.stderr)
  }
}

/** Every output's text, by path, beside the build info. */
async function outputs(root) {
  const files = {}
  for (const project of projects)
    for (const file of await readdir(join(root, "packages", project, "dist")))
      files[`${project}/${file}`] = await readFile(join(root, "packages", project, "dist", file), "utf8")
  return files
}

const now = Date.now()
const at = seconds => new Date(now + seconds * 1000)

/** Main's entry, built at the gate's checkout: `up` before the checkout's files were written, `mid` and `down` after. */
async function mainEntry() {
  const root = await checkout("main", base, at(-900))
  assert.equal(build(root).ok, true, "main's sources build")
  const entry = await save(root, "main")
  for (const [project, seconds] of [["up", -660], ["mid", -540], ["down", -540]])
    for (const file of [join(entry, project, "tsconfig.tsbuildinfo"), ...(await readdir(join(entry, project, "dist"))).map(name => join(entry, project, "dist", name))])
      await utimes(file, at(seconds), at(seconds))
  return entry
}

/** The gate checked out at -600 and built now; the performance job checked out at -60, then restored the gate's entry. */
async function replay(aged) {
  const label = aged ? "aged" : "as-restored"
  const main = await mainEntry()
  const gateTree = await checkout(`gate-${label}`, change, at(-600))
  await restore(main, gateTree, aged)
  const gate = build(gateTree)
  const gateOutputs = await outputs(gateTree)
  const entry = await save(gateTree, `gate-${label}`)
  const performanceTree = await checkout(`performance-${label}`, change, at(-60))
  await restore(entry, performanceTree, aged)
  const performance = build(performanceTree)
  return { gate, gateOutputs, performance, performanceOutputs: await outputs(performanceTree) }
}

const coldTree = await checkout("cold", change, at(-60))
assert.equal(build(coldTree).ok, true, "the pull request's sources build cold")
const cold = await outputs(coldTree)
assert.match(cold["mid/index.d.ts"], /tool\?: string/)

const stale = await replay(false)
assert.equal(stale.gate.ok, true, `the compiler no longer re-stamps a project whose build info is newer than its sources; age-restored-build.mjs may be unneeded:\n${stale.gate.output}`)
assert.doesNotMatch(stale.gateOutputs["mid/index.d.ts"], /tool\?: string/, "the compiler no longer trusts times over a restored build; age-restored-build.mjs may be unneeded")
assert.equal(stale.performance.ok, false, "without aging, the performance job's build should fail as PR #987's did")
assert.match(stale.performance.output, /TS2554/)

const fixed = await replay(true)
assert.equal(fixed.gate.ok, true, fixed.gate.output)
assert.deepEqual(fixed.gateOutputs, cold, "the gate's build over main's entry is a cold build's")
assert.equal(fixed.performance.ok, true, fixed.performance.output)
assert.deepEqual(fixed.performanceOutputs, cold, "the performance job's build over the gate's entry is a cold build's")

// An entry saved before this fix (main's declarations under the pull request's key, the build info re-stamped) mends.
const poisoned = await save(join(scratch, "gate-as-restored"), "poisoned")
const mended = await checkout("mended", change, at(-60))
await restore(poisoned, mended, true)
const rebuilt = build(mended)
assert.equal(rebuilt.ok, true, rebuilt.output)
assert.deepEqual(await outputs(mended), cold, "a build over an entry saved stale is a cold build's")
console.log("restored builds: aged build info compiles what changed by content; as restored, it reproduces PR #987's stale build")
