import assert from "node:assert/strict"
import { cp, lstat, mkdtemp, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  resolveLocalIdentity,
  verifyLocalSignature,
} from "./mac-local-signing.mjs"

const target = "/Applications/Mako.app"

/**
 * The default profile's shared host: `host` when one answers, `null` when
 * none listens. A host that is quitting drops connections and answers 503
 * for a moment; that is waited out here, and `closing` is true only when it
 * still had not left after ten seconds.
 */
export async function localRuntime() {
  const { settleRuntime } =
    await import("../dist-electron/runtime-connection.js")
  const { runtimeDataRoot, runtimeLocation } =
    await import("../dist-electron/runtime-service.js")
  const dataRoot = runtimeDataRoot(
    join(homedir(), "Library/Application Support"),
    {}
  )
  const { socket } = runtimeLocation(dataRoot)
  const probe = await settleRuntime(socket)
  return {
    socket,
    host: probe.state === "ready" ? probe.info : null,
    closing: probe.state === "closing",
  }
}

export async function runningProcesses() {
  const { runningBundleProcesses } =
    await import("../dist-electron/local-update-installer.js")
  const pids = await runningBundleProcesses(target)
  const { host, closing } = await localRuntime()
  assert.ok(
    !closing,
    "Mako's shared host is still shutting down and has not released its socket. Nothing was replaced; try again once it has left."
  )
  if (host && !pids.includes(host.pid)) pids.push(host.pid)
  return pids
}

async function main() {
  const args = process.argv.slice(2)
  assert.equal(process.platform, "darwin", "Local installation is macOS-only")
  assert.ok(
    args.length >= 1 &&
      args.length <= 2 &&
      (!args[1] || args[1] === "--install"),
    "Use <Mako.app> [--install]. Without --install this only checks readiness."
  )
  const source = await realpath(resolve(args[0]))
  assert.notEqual(
    source,
    target,
    "The candidate must be outside the installed app"
  )
  const identity = await resolveLocalIdentity(undefined, source)
  const current = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  assert.ok(
    !current || (current.isDirectory() && !current.isSymbolicLink()),
    "The installed app must be a real directory, not a symlink"
  )
  const running = await runningProcesses()
  console.log(
    JSON.stringify(
      {
        source,
        target,
        identity,
        runningPids: running,
        ready: running.length === 0,
      },
      null,
      2
    )
  )
  if (args.includes("--install")) {
    assert.equal(
      running.length,
      0,
      "Mako or its shared host is still running. Finish active work and shut down the host and its MCP clients before installing. Nothing was stopped or replaced."
    )
    const staging = await mkdtemp(join(dirname(target), ".mako-local-install-"))
    const candidate = join(staging, "Mako.app")
    await cp(source, candidate, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
    await verifyLocalSignature(candidate, identity)
    assert.equal(
      (await runningProcesses()).length,
      0,
      `Mako started during preparation. The installed app was not changed; the candidate remains at ${candidate}`
    )
    const {
      GRANTS_RESET_MESSAGE,
      pruneRetainedApplications,
      reconcileGrantIdentity,
      replacePreparedApplication,
    } = await import("../dist-electron/local-update-installer.js")
    const backup = await replacePreparedApplication({
      staging,
      target,
      verify: (app) => verifyLocalSignature(app, identity),
      ready: async () =>
        assert.equal(
          (await runningProcesses()).length,
          0,
          "Mako started during verification. Nothing was replaced."
        ),
    })
    const reset = await reconcileGrantIdentity(target, backup).catch(() => false)
    const pruned = await pruneRetainedApplications(target, backup).catch(() => [])
    console.log(
      `Installed ${target}. Previous app retained at ${backup ?? "none"}.${pruned.length ? ` Removed ${pruned.length} older retained ${pruned.length === 1 ? "copy" : "copies"}.` : ""} Open the installed app before starting a development host.`
    )
    if (reset) console.log(GRANTS_RESET_MESSAGE)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
