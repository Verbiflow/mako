import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPackage, extractFile } from "@electron/asar"
import { readLocalAppMetadata } from "./local-app-metadata.mjs"
import { selectLocalSigner, sweepLocalUpdates, updateLocal } from "./update-local.mjs"

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
    ensureSpace: async () => {
      calls.push({ command: "space" })
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
  ["space", "npm", "reserve", "prepare", "wait", "wait", process.execPath, "open", "verify-startup", "release", "remove"]
)
// Installing copied the app into /Applications; the output goes last.
assert.equal(success.calls.at(-1).path, options.output)
assert.deepEqual(success.calls[1].args, [
  "run",
  "package:mac:local",
  "--",
  `--output=${options.output}`,
])
assert.equal(success.calls[1].env.MAKO_LOCAL_SIGNING_IDENTITY, identity)
assert.deepEqual(success.calls.find((call) => call.command === process.execPath).args, [
  join(options.project, "scripts/install-local-mac.mjs"),
  join(options.output, "mac-arm64/Mako.app"),
  "--install",
])
const declined = fixture({ confirm: async () => false })
await updateLocal(options, declined.dependencies)
assert.deepEqual(
  declined.calls.map((call) => call.command),
  ["space", "npm", "remove"]
)
const badSigner = fixture({ verify: async () => "B".repeat(40) })
await assert.rejects(
  updateLocal(options, badSigner.dependencies),
  /different signer/
)
assert.deepEqual(
  badSigner.calls.map((call) => call.command),
  ["space", "npm", "remove"]
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
  ["space", "npm", "reserve", "prepare", "cancel", "release", "remove"]
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
assert.deepEqual(failed.calls.map((call) => call.command), ["space", "remove"])
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
  console.log(
    "One-command update: removed build output on install, decline and failure, disk refusal before building, stale output sweep, fresh metadata after archive replacement, verified signer reuse, no fallback from a bad installed signature, ambiguity refusal, ordered build/install, confirmation, wait cancellation, failures, and literal paths passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
