import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { useWorkspaceSource } from "./lib/workspace-source.mjs"

/**
 * `npm run update:local` runs the checkout's own code, and stops what it
 * started whole.
 *
 * It ran under plain node, so `@mako/host/...` and `@mako/git` came from
 * packages/<name>/dist: the fetch, fast-forward and dependency logic that ran
 * was the last compile's, and on a checkout compiled before
 * local-update-dependencies existed the import failed, then failed again in
 * the error handler as an unhandled rejection. It now loads each workspace
 * package from source (`scripts/lib/workspace-source.mjs`).
 *
 * Its npm steps were spawned with `signal`: on Ctrl+C or the install's time
 * limit only npm's own pid got SIGTERM, and what npm had started kept writing
 * node_modules while a rerun installed over it. They now stop the whole
 * process group and settle only once it's gone (`runProcessGroup`), as
 * Settings' steps do.
 */

const project = dirname(dirname(fileURLToPath(import.meta.url)))
// Like the CLI itself: this suite's own imports of the checkout's packages are its source.
useWorkspaceSource(project)
const { reportFailure, runStep } = await import("./update-local.mjs")
const { runProcessGroup } = await import("@mako/host/application/process-group")
const root = await mkdtemp(join(tmpdir(), "mako-update-local-cli-"))
const write = (path, text) => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, text))
const gone = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === "ESRCH"
  }
}
const until = async (check, what) => {
  for (const deadline = Date.now() + 10_000; !(await check()); ) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

try {
  // A checkout compiled before local-update-dependencies existed, and whose @mako/git dist is a compile behind its
  // source: the real update-local.mjs, beside packages whose dist is missing a module and stale in another.
  const checkout = join(root, "checkout")
  for (const file of ["update-local.mjs", "local-app-metadata.mjs", "mac-local-signing.mjs", "install-local-mac.mjs", "lib/workspace-source.mjs", "lib/workspace-source-hooks.mjs"])
    await cp(join(project, "scripts", file), join(checkout, "scripts", file))
  await mkdir(join(checkout, "node_modules/@mako"), { recursive: true })
  for (const name of ["zod", "tsx", "@electron"]) await symlink(join(project, "node_modules", name), join(checkout, "node_modules", name))
  for (const name of ["host", "git"]) await symlink(join(checkout, "packages", name), join(checkout, "node_modules/@mako", name))
  const json = (value) => JSON.stringify(value, null, 2)
  await write(join(checkout, "packages/host/package.json"), json({ name: "@mako/host", type: "module", exports: { "./application/*": "./dist/application/*.js", "./contracts/*": "./dist/contracts/*.js" } }))
  await write(join(checkout, "packages/host/dist/contracts/update-source-text.js"), "export const missingDependenciesText = () => 'stale dist'\n")
  await write(join(checkout, "packages/host/src/contracts/update-source-text.ts"), "export const missingDependenciesText = ({ names }: { names: string[] }): string => `${names.join(', ')}.`\n")
  await write(join(checkout, "packages/host/src/application/local-update-dependencies.ts"), [
    "import type { Git } from '@mako/git'",
    "export const uninstalledPackages = async (_project: string): Promise<string[]> => ['dep']",
    "export const missingDependencies = (names: string[]) => ({ count: names.length, names })",
    "export async function installDependencies(git: Git, _project: string, _missing: string[], options: { installing: () => void; run: (args: string[]) => Promise<void> }): Promise<void> {",
    "  options.installing()",
    "  await options.run(['install', `with ${git.where} git`])",
    "}",
    "",
  ].join("\n"))
  await write(join(checkout, "packages/git/package.json"), json({ name: "@mako/git", type: "module", exports: { ".": "./dist/index.js" } }))
  await write(join(checkout, "packages/git/dist/index.js"), "export class Git { where = 'stale dist'; close() {} }\n")
  await write(join(checkout, "packages/git/src/index.ts"), "export class Git { where: string = 'source'; close(): void {} }\n")
  const probe = join(root, "probe.mjs")
  await writeFile(probe, `
    const [cli, fromSource] = [process.argv[2], process.argv[3] === "source"]
    const { prepareDependencies, reportFailure, useCheckoutSource } = await import(cli)
    if (fromSource) useCheckoutSource()
    try {
      await prepareDependencies({ project: "", say: (line) => console.log(line), run: async (args) => console.log(args.join(" ")) })
    } catch (error) {
      reportFailure(error, (line) => console.log(line))
      process.exitCode = 1
    }
  `)
  const cli = join(checkout, "scripts/update-local.mjs")
  const probeRun = (mode) => spawnSync(process.execPath, [probe, cli, mode], { cwd: root, encoding: "utf8" })
  // Loaded from dist, as plain node did: the missing module stops it, and the failure is said without failing again.
  const compiled = probeRun("dist")
  assert.equal(compiled.status, 1, compiled.stderr)
  assert.match(compiled.stdout, /Cannot find module .*host\/dist\/application\/local-update-dependencies\.js/)
  assert.doesNotMatch(compiled.stderr, /Unhandled|ERR_UNHANDLED_REJECTION/)
  // As the CLI runs: the checkout's source, the module dist lacks and the newer @mako/git alike.
  const source = probeRun("source")
  assert.equal(source.status, 0, source.stderr)
  assert.equal(source.stdout, "Installing dependencies… dep.\ninstall with source git\n")

  // The failure path imports nothing; a dependency failure ends with the command to run, on its own line.
  const printed = []
  reportFailure(Object.assign(new Error("npm install failed."), { name: "DependencyInstallError", command: "cd '/x' && npm install" }), (line) => printed.push(line))
  reportFailure(new Error("Something else."), (line) => printed.push(line))
  reportFailure("not an error", (line) => printed.push(line))
  assert.deepEqual(printed, ["npm install failed.", "\n  cd '/x' && npm install\n", "Something else.", "Local update failed."])
  // The real CLI, failing: one message, exit 1, nothing unhandled.
  const refused = spawnSync(process.execPath, [join(project, "scripts/update-local.mjs"), "--unknown"], { encoding: "utf8" })
  assert.equal(refused.status, 1)
  assert.equal(refused.stderr.trim(), "Use npm run update:local, optionally with -- --check or -- --help.")

  // Ctrl+C (or the install's time limit) during npm: npm's install script, in npm's group, is stopped with it, and
  // the step settles only once it's gone, so nothing is still writing when a rerun starts.
  const fake = join(root, "bin")
  const grandchild = join(root, "grandchild.pid")
  await write(join(fake, "npm"), `#!/bin/sh\nsleep 120 &\necho $! > '${grandchild}'\nwait\n`)
  await chmod(join(fake, "npm"), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${fake}:${path}`
  try {
    const abort = new AbortController()
    const step = runStep("npm", ["install"], {}, abort.signal)
    await until(() => readFile(grandchild, "utf8").then(Boolean, () => false), "npm's install script to start")
    const sleeper = Number(await readFile(grandchild, "utf8"))
    abort.abort(new Error("Cancelled"))
    const stopped = await step.then(() => null, (error) => error)
    assert.ok(gone(sleeper), "npm's install script was stopped before the step settled")
    assert.match(stopped?.message ?? "", /Cancelled/, "the step fails with why it was stopped")
    // An aborted step never starts.
    await assert.rejects(runStep("npm", ["install"], {}, abort.signal), /Cancelled/)
    // Failing is said as before.
    await write(join(fake, "npm"), "#!/bin/sh\nexit 3\n")
    await assert.rejects(runStep("npm", ["run", "build"], {}, new AbortController().signal), /npm did not finish successfully\. No later update steps were run\./)
  } finally {
    process.env.PATH = path
  }

  // Something in the group that ignores SIGTERM gets SIGKILL after the grace, and the step waits for that too.
  const stubborn = join(root, "stubborn.pid")
  await write(join(fake, "stubborn"), `#!/bin/sh\nsh -c 'trap "" TERM; echo $$ > "${stubborn}"; while :; do sleep 1; done' &\nwait\n`)
  await chmod(join(fake, "stubborn"), 0o755)
  const timed = runProcessGroup(join(fake, "stubborn"), [], { cwd: root, env: process.env, stdio: "pipe", timeoutMs: 300, graceMs: 300 })
  await until(() => readFile(stubborn, "utf8").then(Boolean, () => false), "the stubborn child to start")
  const holdout = Number(await readFile(stubborn, "utf8"))
  const result = await timed
  assert.equal(result.stopped, "timeout")
  assert.ok(gone(holdout), "a child ignoring SIGTERM was killed before the step settled")
  // A step that ends by itself is waited for as before: its code, nothing stopped.
  assert.deepEqual(await runProcessGroup("sh", ["-c", "exit 4"], { cwd: root, env: process.env, stdio: "pipe" }), { code: 4, stopped: null })

  console.log("update:local runs the checkout's source (a module dist lacks, a stale dist), says a failure once without failing again, and stops npm's whole process group on Ctrl+C or a time limit, SIGKILL after the grace, settling once it's gone")
} finally {
  await rm(root, { recursive: true, force: true })
}
