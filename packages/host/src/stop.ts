import { randomUUID } from "node:crypto"
import { parseArgs } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { LifecycleStateSchema } from "./contracts/app-lifecycle.js"
import { errorMessage } from "./base/error-message.js"
import { appDataFolder, invokeRuntime, probeRuntime, runtimeDataRoot, runtimeLocation } from "./transport/index.js"

const USAGE = `Usage: mako-host stop [--profile <name> | --data-root <dir>] [--now] [--timeout <seconds>]

Asks a running host to quit through its own stop: its work ends, its stores are
closed and what it kept is written, as on a signal. Where there is no signal to
send (Windows ends a process outright), this is how a host is stopped.

  (no option)           the installed app's host, or MAKO_DATA_ROOT's
  --profile <name>      a profile's host
  --data-root <dir>     the host of that data root, as a machine runs it
  --now                 stop the agents working now, where they can be; without it the host quits once they finish
  --timeout <seconds>   how long to wait for it to be gone (default 60)

Exits 0 once the host is gone (or none was running), 1 if it's still there.`

/** Asks the host to quit, waits for it to be gone, and returns the process's exit code. */
export async function stopHost(args: string[]): Promise<number> {
  const { values: options } = parseArgs({
    args,
    options: {
      profile: { type: "string" },
      "data-root": { type: "string" },
      now: { type: "boolean", default: false },
      timeout: { type: "string", default: "60" },
      help: { type: "boolean", default: false },
    },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const env = { ...process.env, MAKO_PROFILE: options.profile ?? "", MAKO_DATA_ROOT: options["data-root"] ?? process.env.MAKO_DATA_ROOT }
  const dataRoot = runtimeDataRoot(appDataFolder(env), env)
  const seconds = Number(options.timeout)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error("mako-host stop: --timeout is a number of seconds")
    return 64
  }
  // Read each time: on Windows a host publishes a pipe of its own for each start.
  const socket = () => runtimeLocation(dataRoot).socket
  const first = await probeRuntime(socket(), { timeoutMs: 5_000 }).catch(() => undefined)
  if (first?.state !== "ready") {
    console.log("No Mako host is running for this data root.")
    return 0
  }
  const pid = first.info.pid
  const client = randomUUID()
  try {
    const state = LifecycleStateSchema.parse(await invokeRuntime(socket(), client, "mako:lifecycle-state", []))
    const command = options.now && state.work.length ? { kind: "stop", action: "quit", revision: state.revision } : { kind: "wait", action: "quit" }
    const after = LifecycleStateSchema.parse(await invokeRuntime(socket(), client, "mako:lifecycle-command", [command]))
    if (after.operation.kind === "error") {
      console.error(`mako-host stop: ${after.operation.message}`)
      return 1
    }
    if (after.work.length) console.log(`Waiting for ${after.work.length} piece${after.work.length === 1 ? "" : "s"} of work to finish; --now stops what can be stopped.`)
  } catch (error) {
    // A host that quit as it answered dropped the call: whether it's gone is what counts.
    if ((await probeRuntime(socket(), { timeoutMs: 2_000 }).catch(() => undefined))?.state === "ready") {
      console.error(`mako-host stop: the host on ${socket()}: ${errorMessage({ error })}`)
      return 1
    }
  }
  for (const deadline = Date.now() + seconds * 1_000; Date.now() < deadline; await delay(100)) {
    const probe = await probeRuntime(socket(), { timeoutMs: 2_000 }).catch(() => undefined)
    if (probe?.state !== "ready" && probe?.state !== "closing" && !alive(pid)) {
      console.log(`Host ${pid} stopped.`)
      return 0
    }
  }
  console.error(`mako-host stop: host ${pid} is still running after ${seconds} s`)
  return 1
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}
