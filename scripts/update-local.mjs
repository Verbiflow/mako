import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createInterface } from "node:readline/promises"
import { setTimeout as delay } from "node:timers/promises"
import { extractFile } from "@electron/asar"
import { z } from "zod"
import { resolveLocalIdentity } from "./mac-local-signing.mjs"
import { localRuntime, runningProcesses } from "./install-local-mac.mjs"

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const distribution = z.object({ makoDistribution: z.string().optional() })

async function localApp(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return false
  const metadata = distribution.parse(
    JSON.parse(
      extractFile(
        join(path, "Contents/Resources/app.asar"),
        "package.json"
      ).toString("utf8")
    )
  )
  return metadata.makoDistribution === "local"
}

export async function selectLocalSigner(
  options,
  verify = resolveLocalIdentity
) {
  if (options.requested !== undefined) return verify(options.requested)
  if (await localApp(options.installed))
    return verify(undefined, options.installed)
  const release = join(options.project, "release")
  const entries = await readdir(release, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") return []
      throw error
    }
  )
  assert.ok(
    entries.length <= 128,
    "Too many release entries to select a signer automatically. Set MAKO_LOCAL_SIGNING_IDENTITY explicitly."
  )
  const identities = new Set()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(release, entry.name, "mac-arm64/Mako.app")
    if (!(await localApp(candidate).catch(() => false))) continue
    const identity = await verify(undefined, candidate).catch(() => null)
    if (identity) identities.add(identity)
  }
  assert.equal(
    identities.size,
    1,
    identities.size
      ? "Local builds use different signing identities. Set MAKO_LOCAL_SIGNING_IDENTITY to choose one."
      : "No verified local signing identity was found. Set MAKO_LOCAL_SIGNING_IDENTITY once for the first build; later updates reuse the installed app's signer."
  )
  return [...identities][0]
}

export async function updateLocal(options, dependencies) {
  const app = join(options.output, "mac-arm64/Mako.app")
  dependencies.say("Building Mako. Running agents are not stopped.")
  await dependencies.run(
    "npm",
    ["run", "package:mac:local", "--", `--output=${options.output}`],
    { MAKO_LOCAL_SIGNING_IDENTITY: options.identity }
  )
  assert.equal(
    await dependencies.verify(undefined, app),
    options.identity,
    "The prepared app has a different signer. Nothing was installed."
  )
  dependencies.say(`Build verified: ${app}`)
  if (!(await dependencies.confirm())) {
    dependencies.say(
      "Installation cancelled. The verified build is kept; your running app was not changed."
    )
    return
  }
  const closing = await dependencies.prepareToClose()
  let installed = false
  try {
    let waiting = false
    for (;;) {
      const running = await dependencies.running()
      if (!running.length) break
      if (!waiting)
        dependencies.say(
          `Waiting for Mako to close (pids ${running.join(", ")}). On the older app, finish active work and fully quit Mako. Nothing will be force-stopped. Ctrl+C cancels this wait.`
        )
      waiting = true
      await closing?.check()
      await dependencies.wait()
    }
    await dependencies.run(
      process.execPath,
      [
        join(options.project, "scripts/install-local-mac.mjs"),
        app,
        "--install",
      ],
      {}
    )
    installed = true
    await dependencies.run("open", ["/Applications/Mako.app"], {})
    await dependencies.verifyStarted(app)
    dependencies.say("Mako updated. The new shared host is ready.")
  } catch (error) {
    if (!installed) {
      try {
        await closing?.cancel()
      } catch (cancelError) {
        dependencies.say(
          `Could not cancel the pending quit: ${cancelError instanceof Error ? cancelError.message : "check Settings > Updates"}`
        )
      }
    }
    throw error
  }
}

async function run(command, args, env, signal) {
  if (command !== "open") signal.throwIfAborted()
  const inherited = { ...process.env, ...env }
  delete inherited.ELECTRON_RUN_AS_NODE
  const launchEnv =
    command === "open"
      ? (
          await import("../dist-electron/local-update-installer.js")
        ).desktopLaunchEnvironment(inherited)
      : inherited
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      detached: true,
      stdio: "inherit",
      signal: command === "npm" ? signal : undefined,
      env: launchEnv,
    })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} did not finish successfully. No later update steps were run.`
            )
          )
    )
  })
}

async function prepareToClose() {
  const { socket, host } = await localRuntime()
  if (!host?.methods.includes("mako:lifecycle-command")) return
  const { invokeRuntime, RuntimeDisconnectedError } =
    await import("../dist-electron/runtime-connection.js")
  const client = randomUUID()
  const state = z
    .object({ operation: z.object({ kind: z.string() }) })
    .parse(await invokeRuntime(socket, client, "mako:lifecycle-state", []))
  if (state.operation.kind !== "idle" && state.operation.kind !== "error")
    throw new Error(
      "Mako already has a pending update or restart. Cancel it in Settings > Updates before continuing here."
    )
  console.log(
    "Asking Mako to close after active agents finish. Queued work and requests for input are allowed to finish first."
  )
  const result = z
    .object({
      operation: z.object({ kind: z.string(), message: z.string().optional() }),
    })
    .parse(
      await invokeRuntime(socket, client, "mako:lifecycle-command", [
        { kind: "wait", action: "quit" },
      ])
    )
  if (result.operation.kind === "error")
    throw new Error(result.operation.message ?? "Mako could not close safely.")
  // The host's own lifecycle state, or null once it is leaving. Between the
  // probe and the call the host can begin its close and answer with a typed
  // disconnect; that is the quit we asked for, not a failure to report.
  const read = async () => {
    const current = await localRuntime()
    if (!current.host) return null
    if (current.host.instanceId !== host.instanceId)
      throw new Error(
        "The shared host changed while waiting. Nothing was installed."
      )
    let state
    try {
      state = await invokeRuntime(socket, client, "mako:lifecycle-state", [])
    } catch (error) {
      if (error instanceof RuntimeDisconnectedError) return null
      throw error
    }
    return z
      .object({
        operation: z.object({
          kind: z.string(),
          action: z.string().optional(),
          message: z.string().optional(),
        }),
      })
      .parse(state)
  }
  return {
    async check() {
      const state = await read()
      if (!state) return
      if (state.operation.kind === "error")
        throw new Error(
          state.operation.message ?? "Mako could not close safely."
        )
      if (state.operation.action !== "quit")
        throw new Error(
          "The pending quit was cancelled or changed in Mako. Nothing was installed."
        )
    },
    async cancel() {
      const state = await read()
      if (
        state?.operation.kind === "waiting" &&
        state.operation.action === "quit"
      )
        await invokeRuntime(socket, client, "mako:lifecycle-command", [
          { kind: "cancel" },
        ])
    },
  }
}

async function verifyStarted(candidate) {
  const expected = z
    .object({ makoBuild: z.object({ id: z.string() }) })
    .parse(
      JSON.parse(
        extractFile(
          join(candidate, "Contents/Resources/app.asar"),
          "package.json"
        ).toString("utf8")
      )
    ).makoBuild.id
  const { invokeRuntime, RuntimeDisconnectedError } =
    await import("../dist-electron/runtime-connection.js")
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const { host, socket } = await localRuntime()
    if (host) {
      let state
      try {
        state = await invokeRuntime(
          socket,
          randomUUID(),
          "mako:installation-state",
          []
        )
      } catch (error) {
        // The new host answered its health probe and then closed that
        // connection; it is still coming up, so ask again.
        if (!(error instanceof RuntimeDisconnectedError)) throw error
        await delay(250)
        continue
      }
      const installed = z
        .object({ build: z.object({ id: z.string() }).nullable() })
        .parse(state)
      if (installed.build?.id !== expected)
        throw new Error(
          "Mako started a different host build. The update was installed, but startup was not verified."
        )
      process.kill(host.pid, 0)
      return
    }
    await delay(250)
  }
  throw new Error(
    "The update was installed, but its shared host did not start. The previous app is retained; do not run another build to diagnose this."
  )
}

async function main() {
  const args = process.argv.slice(2)
  assert.ok(
    args.every((arg) => arg === "--check" || arg === "--help"),
    "Use npm run update:local, optionally with -- --check or -- --help."
  )
  if (args.includes("--help")) {
    console.log(
      "npm run update:local\n\nBuilds a locally signed Mako, asks before installing, waits for Mako to close safely, installs, and reopens it. Never force-stops agents.\n\n--check  Verify signer selection and report running processes without building or installing."
    )
    return
  }
  assert.equal(process.platform, "darwin", "Local updating is macOS-only")
  const identity = await selectLocalSigner({
    project,
    installed: "/Applications/Mako.app",
    requested: process.env.MAKO_LOCAL_SIGNING_IDENTITY,
  })
  if (args.includes("--check")) {
    console.log(
      JSON.stringify(
        { identity, runningPids: await runningProcesses(), changed: false },
        null,
        2
      )
    )
    return
  }
  assert.ok(
    process.stdin.isTTY && process.stdout.isTTY,
    "Run npm run update:local in an interactive terminal so you can confirm installation."
  )
  await mkdir(join(project, "release"), { recursive: true })
  const output = await mkdtemp(join(project, "release/.local-update-"))
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.once("SIGINT", cancel)
  try {
    await updateLocal(
      { project, output, identity },
      {
        say: console.log,
        run: (command, args, env) => run(command, args, env, abort.signal),
        verify: resolveLocalIdentity,
        verifyStarted,
        confirm: async () => {
          const terminal = createInterface({
            input: process.stdin,
            output: process.stdout,
          })
          terminal.once("SIGINT", cancel)
          try {
            return /^y(?:es)?$/i.test(
              (
                await terminal.question(
                  "Install this build once agents finish? The previous app will be kept. [y/N] ",
                  { signal: abort.signal }
                )
              ).trim()
            )
          } finally {
            terminal.close()
          }
        },
        prepareToClose: () => {
          abort.signal.throwIfAborted()
          return prepareToClose()
        },
        running: runningProcesses,
        wait: () => delay(2000, undefined, { signal: abort.signal }),
      }
    )
  } finally {
    process.removeListener("SIGINT", cancel)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Local update failed."
    )
    process.exitCode = 1
  })
}
