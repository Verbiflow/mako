import { invokeControlSession } from "./control-session-client.js"
import { refuseControlConnection } from "./control-session-server.js"
import {
  CONTROL_SESSION_PROTOCOL,
  type SessionDescriptor,
  type SessionOperation,
} from "./control-session-protocol.js"
import type { Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ControlFault } from "@mako/control/control"
import { listenPrivateControlSocket } from "./private-socket.js"
import { createLaunchFolder } from "./launch-folders.js"
import { ControlWorkers, type ControlWorker, type ControlWorkerOptions } from "./control-workers.js"
import type { DesktopSessionConfig } from "./desktop-session-config.js"

export interface ControlLaunch {
  bin: string
  command: string
  sessionFile: string
}
type NativeDriver = NonNullable<DesktopSessionConfig["native"]>
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/**
 * A task's Local Control session, ready at once and started on first use.
 * The launch files and the listening socket exist from the start, so the
 * agent's environment is the same as ever; the first connection, from the CLI
 * or from this process's own `request`, takes a worker and hands it the
 * socket with every connection waiting on it. A task that never uses the
 * computer never starts one.
 */
export async function startDesktopControlSession(
  input: DesktopSessionConfig,
  options: ControlWorkerOptions & {
    /** Where workers come from; without it, each session spawns its own. */
    workers?: ControlWorkers
    /** The native driver, resolved when the session first starts, in place of `input.native`. */
    native?: () => Promise<NativeDriver | undefined>
  } = {}
) {
  const workers = options.workers ?? new ControlWorkers({ ...options, spare: false })
  workers.sweepAbandonedLaunches()
  const directory = await createLaunchFolder()
  const files = join(directory, "session")
  const command = join(directory, "mako-control")
  const sessionFile = join(files, "session.json")
  let state: "waiting" | "starting" | "running" | "ended" = "waiting"
  let worker: ControlWorker | undefined
  let starting: Promise<void> | undefined
  const waiting: Socket[] = []
  let ended!: (reason: "stopped" | "failed") => void
  const exited = new Promise<"stopped" | "failed">((resolve) => { ended = resolve })
  let closing: Promise<void> | undefined
  let listener: Awaited<ReturnType<typeof listenPrivateControlSocket>> | undefined
  let descriptor: SessionDescriptor | undefined

  /** `close` can end the session while a start awaits. */
  const over = () => state === "ended"
  const closed = (connection: Socket) =>
    refuseControlConnection(connection, { code: "session-closed", message: "This task's Local Control session has ended; no action was dispatched." })
  const release = async (reason: "stopped" | "failed") => {
    state = "ended"
    for (const connection of waiting.splice(0)) closed(connection)
    await listener?.close()
    await rm(directory, { recursive: true, force: true })
    ended(reason)
  }
  const start = async (session: SessionDescriptor) => {
    state = "starting"
    try {
      const taken = workers.take()
      worker = taken
      const native = options.native ? await options.native() : input.native
      await taken.bind({ ...input, native }, session, files, listener!.server)
      if (over()) return
      state = "running"
      for (const connection of waiting.splice(0)) taken.hand(connection, closed)
      await listener!.release()
      void taken.exited.then((reason) => { if (!over()) void release(reason) })
    } catch (error) {
      const fault = error instanceof ControlFault ? { code: error.code, message: error.message } : {
        code: "session-start-failed",
        message: "Local Control couldn't start for this task; no action was dispatched. Start a new task to try again.",
      }
      for (const connection of waiting.splice(0)) refuseControlConnection(connection, fault)
      void worker?.stop()
      if (!over()) await release("failed")
    }
  }

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      state = "ended"
      await starting
      await worker?.stop()
      await release("stopped")
    })())

  try {
    await mkdir(files, { mode: 0o700 })
    listener = await listenPrivateControlSocket(files, "session.sock")
    descriptor = {
      protocol: CONTROL_SESSION_PROTOCOL,
      build: await workers.build,
      session: randomUUID(),
      socket: listener.path,
      pid: process.pid,
    }
    const session = descriptor
    listener.server.on("connection", (connection: Socket) => {
      if (state === "running" && worker) return worker.hand(connection, closed)
      if (state === "ended") return closed(connection)
      waiting.push(connection)
      if (state === "waiting") starting = start(session)
    })
    await writeFile(sessionFile, JSON.stringify(descriptor) + "\n", { mode: 0o600, flag: "wx" })
    const executable = options.executable ?? process.execPath
    const cli = fileURLToPath(new URL("./control-cli.js", import.meta.url))
    await writeFile(
      command,
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport MAKO_CONTROL_SESSION_FILE=${quote(sessionFile)}\nexec ${quote(executable)} ${quote(cli)} "$@"\n`,
      { mode: 0o700, flag: "wx" }
    )
  } catch (error) {
    await close()
    throw error
  }
  if (!options.workers) void exited.then(() => workers.close())
  return {
    request: (operation: SessionOperation, signal: AbortSignal) => {
      if (state === "ended")
        throw new ControlFault("session-closed", "This task's Local Control session is no longer active.", "not-dispatched")
      return invokeControlSession(session(), operation, signal)
    },
    launch: { bin: directory, command, sessionFile } satisfies ControlLaunch,
    /** The worker serving this session, once it started and while it runs. */
    get pid() {
      return state === "running" ? worker?.pid : undefined
    },
    exited,
    close,
  }

  function session(): SessionDescriptor {
    if (!descriptor) throw new Error("Local Control session isn't listening")
    return descriptor
  }
}
