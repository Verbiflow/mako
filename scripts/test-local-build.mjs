import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Git } from "@mako/git"
import { LocalUpdates } from "@mako/host/application/local-updates"
import { resolveLocalIdentity } from "./mac-local-signing.mjs"

async function buildFromSettings() {
  const root = process.env.MAKO_BUILD_TEST_ROOT
  const source = process.env.MAKO_BUILD_TEST_SOURCE
  const identity = process.env.MAKO_BUILD_TEST_IDENTITY
  const phases = []
  let finish
  const settled = new Promise((resolve) => { finish = resolve })
  const updater = new LocalUpdates(new Git(), join(root, "updates"), identity, () => {
    const state = updater.snapshot().local
    if (state.kind === "building" && phases.at(-1) !== state.phase) { phases.push(state.phase); console.log(`Settings build: ${state.phase}`) }
    if (!updater.building && (state.kind === "ready" || state.kind === "error")) finish(state)
  })
  await updater.select(source)
  updater.start()
  const result = await settled
  await writeFile(join(root, "result.json"), JSON.stringify({ source, phases, result }, null, 2))
  assert.equal(result.kind, "ready", result.message)
  const candidate = await updater.prepared()
  console.log(`Settings build verified without installation: ${candidate.app}`)
  console.log(`Settings build evidence: ${root}`)
}

if (process.versions.electron) {
  const { app } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_BUILD_TEST_ROOT, "profile"))
  void buildFromSettings().then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1) })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-settings-build-"))
  await mkdir(join(root, "profile"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-settings-build", main: fileURLToPath(import.meta.url) }))
  const identity = await resolveLocalIdentity(process.env.MAKO_LOCAL_SIGNING_IDENTITY)
  const env = { ...process.env, MAKO_BUILD_TEST_ROOT: root, MAKO_BUILD_TEST_SOURCE: resolve(process.argv[2] ?? "."), MAKO_BUILD_TEST_IDENTITY: identity }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)) })
}
