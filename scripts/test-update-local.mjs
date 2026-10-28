import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPackage, extractFile } from "@electron/asar"
import { readLocalAppMetadata } from "./local-app-metadata.mjs"
import { prepareSource, selectLocalSigner, sweepLocalUpdates, updateLocal } from "./update-local.mjs"

const identity = "A".repeat(40)
const options = {
  project: "/fixture/checkout with spaces",
  output: "/fixture/prepared build",
  identity,
}
function fixture(overrides = {}) {
  const calls = []
  let checks = 0
  const dependencies = {
    say: () => {},
    source: async () => {
      calls.push({ command: "source" })
      return true
    },
    ensureSpace: async () => {
      calls.push({ command: "space" })
    },
    packages: async () => {
      calls.push({ command: "packages" })
    },
    remove: async (path) => {
      calls.push({ command: "remove", path })
    },
    run: async (command, args, env) => {
      calls.push({ command, args, env })
    },
    verify: async () => identity,
    verifyStarted: async () => {
      calls.push({ command: "verify-startup" })
    },
    confirm: async () => true,
    prepareToClose: async () => {
      calls.push({ command: "prepare" })
      return {
        check: async () => {},
        cancel: async () => {
          calls.push({ command: "cancel" })
        },
      }
    },
    reserveReplacement: async () => {
      calls.push({ command: "reserve" })
      return async () => {
        calls.push({ command: "release" })
      }
    },
    running: async () => (checks++ < 2 ? [123] : []),
    wait: async () => {
      calls.push({ command: "wait" })
    },
    ...overrides,
  }
  return { calls, dependencies }
}
const success = fixture()
await updateLocal(options, success.dependencies)
assert.deepEqual(
  success.calls.map((call) => call.command),
  ["space", "source", "packages", "npm", "reserve", "prepare", "wait", "wait", process.execPath, "open", "verify-startup", "release", "remove"]
)
// Installing copied the app into /Applications; the output goes last.
assert.equal(success.calls.at(-1).path, options.output)
assert.deepEqual(success.calls[3].args, [
  "run",
  "package:mac:local",
  "--",
  `--output=${options.output}`,
])
assert.equal(success.calls[3].env.MAKO_LOCAL_SIGNING_IDENTITY, identity)
assert.deepEqual(success.calls.find((call) => call.command === process.execPath).args, [
  join(options.project, "scripts/install-local-mac.mjs"),
  join(options.output, "mac-arm64/Mako.app"),
  "--install",
])
// The installed app already carries what the checkout holds: nothing is built, and the empty output still goes.
const current = fixture({
  source: async () => {
    current.calls.push({ command: "source" })
    return false
  },
})
await updateLocal(options, current.dependencies)
assert.deepEqual(current.calls.map((call) => call.command), ["space", "source", "remove"])
const declined = fixture({ confirm: async () => false })
await updateLocal(options, declined.dependencies)
assert.deepEqual(
  declined.calls.map((call) => call.command),
  ["space", "source", "packages", "npm", "remove"]
)
const badSigner = fixture({ verify: async () => "B".repeat(40) })
await assert.rejects(
  updateLocal(options, badSigner.dependencies),
  /different signer/
)
assert.deepEqual(
  badSigner.calls.map((call) => call.command),
  ["space", "source", "packages", "npm", "remove"]
)
const interrupted = fixture({
  wait: async () => {
    throw new Error("Cancelled")
  },
})
await assert.rejects(
  updateLocal(options, interrupted.dependencies),
  /Cancelled/
)
assert.deepEqual(
  interrupted.calls.map((call) => call.command),
  ["space", "source", "packages", "npm", "reserve", "prepare", "cancel", "release", "remove"]
)
const masked = fixture({
  running: async () => [],
  prepareToClose: async () => ({
    check: async () => {},
    cancel: async () => {
      throw new Error("cancel failed")
    },
  }),
  run: async (command) => {
    if (command === process.execPath) throw new Error("install failed")
  },
})
await assert.rejects(
  updateLocal(options, masked.dependencies),
  /install failed/
)
const remoteFailure = fixture({
  prepareToClose: async () => ({
    check: async () => {
      throw new Error("unsaved draft prevented shutdown")
    },
    cancel: async () => {},
  }),
})
await assert.rejects(
  updateLocal(options, remoteFailure.dependencies),
  /unsaved draft prevented shutdown/
)
assert.equal(
  remoteFailure.calls.some((call) => call.command === process.execPath),
  false
)
const startupFailure = fixture({
  verifyStarted: async () => {
    throw new Error("new host did not start")
  },
})
await assert.rejects(
  updateLocal(options, startupFailure.dependencies),
  /new host did not start/
)
assert.equal(
  startupFailure.calls.some((call) => call.command === "cancel"),
  false
)
const failed = fixture({
  run: async () => {
    throw new Error("Build failed")
  },
})
await assert.rejects(updateLocal(options, failed.dependencies), /Build failed/)
assert.deepEqual(failed.calls.map((call) => call.command), ["space", "source", "packages", "remove"])
// npm install refused or failed in the checkout: nothing is built, and the output still goes.
const unpackaged = fixture({
  packages: async () => {
    unpackaged.calls.push({ command: "packages" })
    throw new Error("The checkout has uncommitted changes to package-lock.json, so Mako won't run npm install there for you.")
  },
})
await assert.rejects(updateLocal(options, unpackaged.dependencies), /won't run npm install there/)
assert.deepEqual(unpackaged.calls.map((call) => call.command), ["space", "source", "packages", "remove"])
const full = fixture({
  ensureSpace: async () => {
    throw new Error("Not enough free disk space to build Mako")
  },
})
await assert.rejects(updateLocal(options, full.dependencies), /Not enough free disk space/)
assert.deepEqual(full.calls.map((call) => call.command), ["remove"])
// A removal that fails is reported, and never hides the update's own outcome.
const said = []
const stuck = fixture({
  say: (text) => said.push(text),
  remove: async () => {
    throw new Error("busy")
  },
})
await updateLocal(options, stuck.dependencies)
assert.match(said.at(-1), /Could not remove the build output .*busy/)
const stuckFailure = fixture({
  run: async () => {
    throw new Error("Build failed")
  },
  remove: async () => {
    throw new Error("busy")
  },
})
await assert.rejects(updateLocal(options, stuckFailure.dependencies), /Build failed/)

const root = await mkdtemp(join(tmpdir(), "mako-update-command-"))
async function app(path, distribution) {
  const input = await mkdtemp(join(root, "payload-"))
  await writeFile(
    join(input, "package.json"),
    JSON.stringify({ makoDistribution: distribution })
  )
  await mkdir(join(path, "Contents/Resources"), { recursive: true })
  await createPackage(input, join(path, "Contents/Resources/app.asar"))
}
try {
  // The same updater inspects the old bundle, installs a new archive at that
  // path, then verifies it. ASAR's pathname cache must not survive replacement.
  const swapped = join(root, "swapped.app")
  await app(swapped, "unsigned")
  const archive = join(swapped, "Contents/Resources/app.asar")
  assert.equal(JSON.parse(extractFile(archive, "package.json")).makoDistribution, "unsigned")
  const replacement = await mkdtemp(join(root, "replacement-"))
  await writeFile(join(replacement, "a-padding.txt"), "x".repeat(1000))
  await writeFile(join(replacement, "package.json"), JSON.stringify({ makoDistribution: "local", makoBuild: { id: "replacement" } }))
  await createPackage(replacement, join(root, "replacement.asar"))
  await rename(join(root, "replacement.asar"), archive)
  assert.deepEqual(readLocalAppMetadata(swapped), { makoDistribution: "local", makoBuild: { id: "replacement" } })
  const installed = join(root, "installed.app")
  const local = join(root, "release/known/mac-arm64/Mako.app")
  await app(installed, "unsigned")
  await app(local, "local")
  await mkdir(join(root, "release/unfinished/mac-arm64/Mako.app"), {
    recursive: true,
  })
  const verified = []
  const verify = async (_requested, path) => {
    verified.push(path)
    return identity
  }
  assert.equal(
    await selectLocalSigner({ project: root, installed }, verify),
    identity
  )
  assert.deepEqual(verified, [local])
  const signedInstalled = join(root, "signed.app")
  await app(signedInstalled, "local")
  verified.length = 0
  assert.equal(
    await selectLocalSigner(
      { project: root, installed: signedInstalled },
      verify
    ),
    identity
  )
  assert.deepEqual(verified, [signedInstalled])
  await assert.rejects(
    selectLocalSigner(
      { project: root, installed: signedInstalled },
      async () => {
        throw new Error("Invalid installed signature")
      }
    ),
    /Invalid installed signature/
  )
  const second = join(root, "release/another/mac-arm64/Mako.app")
  await app(second, "local")
  await assert.rejects(
    selectLocalSigner({ project: root, installed }, async (_requested, path) =>
      path === second ? "B".repeat(40) : identity
    ),
    /different signing identities/
  )
  // Earlier runs' outputs go unless a live run owns them or, unmarked, one
  // was touched within the hour; the install lock stops the sweep outright.
  const release = join(root, "release")
  const output = async (name, owner, age = 0) => {
    const folder = join(release, name)
    await mkdir(join(folder, "mac-arm64/Mako.app"), { recursive: true })
    if (owner !== undefined) await writeFile(join(folder, "update-local.pid"), String(owner))
    const time = new Date(Date.now() - age)
    await utimes(folder, time, time)
  }
  const hour = 60 * 60_000
  await output(".local-update-live", 111, 5 * hour)
  await output(".local-update-dead", 222, 5 * hour)
  await output(".local-update-unmarked", undefined, 2 * hour)
  await output(".local-update-fresh", undefined, 0)
  await symlink(join(root, "swapped.app"), join(release, ".local-update-link"))
  const lock = join(root, "Mako.app.update-lock")
  const sweep = () => sweepLocalUpdates({ release, lock, isAlive: (pid) => pid === 111 })
  await writeFile(lock, "{}")
  assert.deepEqual(await sweep(), [], "an installer holding the lock stops the sweep")
  await rm(lock)
  assert.deepEqual((await sweep()).sort(), [join(release, ".local-update-dead"), join(release, ".local-update-unmarked")])
  assert.deepEqual(
    (await readdir(release)).sort(),
    [".local-update-fresh", ".local-update-link", ".local-update-live", "another", "known", "unfinished"]
  )
  // The signer lookup still reads the builds the sweep leaves.
  assert.equal(
    await selectLocalSigner({ project: root, installed }, async () => identity),
    identity
  )

  // The CLI reads the checkout as Settings does: behind and clean, it offers the fast-forward and takes it on yes;
  // declined, it builds what's there; already installed, it builds nothing.
  const gitConfigFile = join(root, "gitconfig")
  await writeFile(gitConfigFile, "")
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfigFile, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfigFile, GIT_CONFIG_NOSYSTEM: "1" })
  const runGit = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const bareRemote = join(root, "remote.git")
  const upstreamWriter = join(root, "writer")
  const sourceCheckout = join(root, "checkout")
  runGit(root, "init", "-q", "--bare", "-b", "main", bareRemote)
  runGit(root, "init", "-q", "-b", "main", upstreamWriter)
  runGit(upstreamWriter, "remote", "add", "origin", bareRemote)
  await writeFile(join(upstreamWriter, "app.txt"), "one\n")
  runGit(upstreamWriter, "add", "app.txt")
  runGit(upstreamWriter, "commit", "-qm", "First (#1)")
  runGit(upstreamWriter, "push", "-q", "origin", "main")
  runGit(root, "clone", "-q", bareRemote, sourceCheckout)
  const firstRevision = runGit(sourceCheckout, "rev-parse", "HEAD")
  await writeFile(join(upstreamWriter, "app.txt"), "two\n")
  runGit(upstreamWriter, "commit", "-qam", "Second (#2)")
  runGit(upstreamWriter, "push", "-q", "origin", "main")
  const secondRevision = runGit(upstreamWriter, "rev-parse", "HEAD")
  const sourceLines = []
  const sourcePrompts = []
  const readSource = (installed, answer) => prepareSource({ project: sourceCheckout, installed, say: (line) => sourceLines.push(line), ask: async (prompt) => (sourcePrompts.push(prompt), answer) })
  assert.equal(await readSource({ revision: firstRevision, dirty: false }, false), true)
  assert.match(sourcePrompts.at(-1), new RegExp(`^Update to main ${secondRevision.slice(0, 8)} \\(1 new change\\)\\? \\[Y/n\\] $`))
  assert.equal(runGit(sourceCheckout, "rev-parse", "HEAD"), firstRevision, "declined, the checkout stays")
  assert.match(sourceLines.at(-1), /^Building main as it is, at /)
  assert.equal(await readSource({ revision: firstRevision, dirty: false }, true), true)
  assert.equal(runGit(sourceCheckout, "rev-parse", "HEAD"), secondRevision)
  assert.equal(await readFile(join(sourceCheckout, "app.txt"), "utf8"), "two\n")
  assert.match(sourceLines.at(-1), new RegExp(`^Moved main forward from ${firstRevision.slice(0, 8)} to ${secondRevision.slice(0, 8)}\\.$`))
  const promptsBefore = sourcePrompts.length
  assert.equal(await readSource({ revision: secondRevision, dirty: false }, true), false, "the installed revision isn't rebuilt")
  assert.match(sourceLines.at(-1), new RegExp(`^You're already on ${secondRevision.slice(0, 8)} \\(main at ${secondRevision.slice(0, 8)} · origin/main at ${secondRevision.slice(0, 8)}\\)\\.`))
  assert.equal(sourcePrompts.length, promptsBefore, "nothing to ask")
  console.log(
    "One-command update: reads the checkout against origin and fast-forwards it on yes, removed build output on install, decline and failure, disk refusal before building, stale output sweep, fresh metadata after archive replacement, verified signer reuse, no fallback from a bad installed signature, ambiguity refusal, ordered build/install, confirmation, wait cancellation, failures, and literal paths passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
