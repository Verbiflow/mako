import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Git } from "@mako/git"
import { LocalUpdates } from "@mako/host/application/local-updates"
import { resolveLocalIdentity } from "./mac-local-signing.mjs"

const USAGE = "Use npm run test:settings-build -- [<checkout>] [--keep] [--as-installed-updater]"

async function buildFromSettings() {
  const root = process.env.MAKO_BUILD_TEST_ROOT
  const source = process.env.MAKO_BUILD_TEST_SOURCE
  const identity = process.env.MAKO_BUILD_TEST_IDENTITY
  const asInstalled = process.env.MAKO_BUILD_TEST_AS_INSTALLED === "1"
  const phases = []
  let finish
  const settled = new Promise((resolve) => { finish = resolve })
  const updater = new LocalUpdates(new Git(), join(root, "updates"), identity, () => {
    const state = updater.snapshot().local
    if (state.kind === "building" && phases.at(-1) !== state.phase) { phases.push(state.phase); console.log(`Settings build: ${state.phase}`) }
    if (!updater.building && (state.kind === "ready" || state.kind === "error")) finish(state)
  }, null, { buildSource: !asInstalled })
  await updater.select(source)
  updater.start()
  const result = await settled
  await writeFile(join(root, "result.json"), JSON.stringify({ source, asInstalledUpdater: asInstalled, phases, result }, null, 2))
  assert.equal(result.kind, "ready", result.message)
  const candidate = await updater.prepared()
  console.log(`Settings build verified without installation: ${candidate.app}`)
}

/**
 * Remove a rehearsal's root: the private checkout copy and a packaged app,
 * several GB that used to stay in the temporary folder for good. Its
 * `result.json` is printed first, so the evidence outlives it.
 */
export async function finishRehearsal(root, { keep, log = console.log, unregister = async () => {} }) {
  const result = await readFile(join(root, "result.json"), "utf8").catch(() => null)
  log(result ? `Settings build result:\n${result}` : "The Settings build wrote no result.")
  if (keep) {
    log(`Settings build kept at ${root} (--keep). Remove it when you're done: it holds a checkout copy and a packaged app.`)
    return
  }
  const updates = join(root, "updates")
  for (const name of await readdir(updates).catch(() => []))
    if (name.startsWith("build-")) await unregister(join(updates, name, "output/mac-arm64/Mako.app"))
  await rm(root, { recursive: true, force: true })
  log(`Removed the Settings build's working folder ${root}. Pass --keep to keep it.`)
}

/** Parse the command line; the checkout defaults to this one. */
export function rehearsalOptions(args) {
  const flags = new Set(["--keep", "--as-installed-updater"])
  const positional = args.filter((arg) => !flags.has(arg))
  assert.ok(positional.length <= 1 && positional.every((arg) => !arg.startsWith("--")), USAGE)
  return {
    source: resolve(positional[0] ?? "."),
    keep: args.includes("--keep"),
    asInstalledUpdater: args.includes("--as-installed-updater"),
  }
}

async function rehearse(args) {
  const options = rehearsalOptions(args)
  const root = await mkdtemp(join(tmpdir(), "mako-settings-build-"))
  try {
    await mkdir(join(root, "profile"))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-settings-build", main: fileURLToPath(import.meta.url) }))
    const identity = await resolveLocalIdentity(process.env.MAKO_LOCAL_SIGNING_IDENTITY)
    const env = {
      ...process.env,
      MAKO_BUILD_TEST_ROOT: root,
      MAKO_BUILD_TEST_SOURCE: options.source,
      MAKO_BUILD_TEST_IDENTITY: identity,
      MAKO_BUILD_TEST_AS_INSTALLED: options.asInstalledUpdater ? "1" : "0",
    }
    delete env.ELECTRON_RUN_AS_NODE
    if (options.asInstalledUpdater) console.log("Rehearsing an installed updater that does not pass MAKO_BUILD_SOURCE to the checks.")
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    // Ctrl+C reaches the build too; wait for it to stop so the folder can go.
    const interrupted = () => {}
    process.on("SIGINT", interrupted)
    try {
      return await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)) })
    } finally {
      process.removeListener("SIGINT", interrupted)
    }
  } finally {
    const { unregisterBundle } = await import("@mako/host/application/local-update-installer")
    await finishRehearsal(root, { keep: options.keep, unregister: unregisterBundle })
  }
}

if (process.versions.electron) {
  const { app } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_BUILD_TEST_ROOT, "profile"))
  void buildFromSettings().then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1) })
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await rehearse(process.argv.slice(2))
}
