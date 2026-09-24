import { fork, type ChildProcess } from "node:child_process"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { createControlDirectory } from "./private-socket.js"
import {
  DesktopSessionConfigSchema,
  type DesktopSessionConfig,
} from "./desktop-session-config.js"

export interface ControlLaunch {
  bin: string
  command: string
  sessionFile: string
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const reply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), file: z.string() }).strict(),
  z.object({ kind: z.literal("failed") }).strict(),
])

/** A task owns the worker; shell processes only borrow its private socket. */
export async function startDesktopControlSession(
  input: DesktopSessionConfig,
  options: {
    executable?: string
    env?: NodeJS.ProcessEnv
    startupMs?: number
    onSpawn?: (child: ChildProcess) => void
  } = {}
) {
  const config = DesktopSessionConfigSchema.parse(input)
  const executable = options.executable ?? process.execPath
  const directory = await createControlDirectory("mako-cli-")
  const supplied = options.env ?? process.env
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" }
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TZ",
    "DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
    "GDK_BACKEND",
    "QT_QPA_PLATFORM",
    "MAKO_CONTROL_MEDIA_ROOT",
    "MAKO_CONTROL_ASYNC_GUARD",
  ])
    if (supplied[key] !== undefined) environment[key] = supplied[key]
  const child = fork(
    fileURLToPath(new URL("./desktop-session-worker.js", import.meta.url)),
    [],
    {
      execPath: executable,
      execArgv: [],
      env: environment,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }
  )
  // Never echo driver/page contents or launch credentials into provider logs.
  child.stderr?.resume()
  let closing: Promise<void> | undefined
  let exited = false
  const exit = new Promise<"stopped" | "failed">((resolve) => {
    const done = (code: number | null) => {
      exited = true
      resolve(code === 0 ? "stopped" : "failed")
    }
    child.once("exit", done)
    child.once("error", () => done(null))
  })
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      if (!exited && child.connected) child.send({ kind: "stop" }, () => {})
      const deadline = setTimeout(() => child.kill("SIGKILL"), 17_000)
      try {
        await exit
      } finally {
        clearTimeout(deadline)
        await rm(directory, { recursive: true, force: true })
      }
    })())
  try {
    options.onSpawn?.(child)
    const sessionFile = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Local Control session startup timed out")),
        options.startupMs ?? 20_000
      )
      const fail = () =>
        reject(new Error("Local Control session exited before becoming ready"))
      child.once("error", fail)
      child.once("exit", fail)
      child.on("message", function received(raw) {
        const message = reply.safeParse(raw)
        if (!message.success) return
        clearTimeout(timer)
        child.off("message", received)
        child.off("error", fail)
        child.off("exit", fail)
        if (message.data.kind === "ready") resolve(message.data.file)
        else reject(new Error("Local Control session startup failed"))
      })
      void exit.then(() => clearTimeout(timer))
      child.send(
        { kind: "start", config, directory: join(directory, "session") },
        (error) => {
          if (error) fail()
        }
      )
    })
    const command = join(directory, "mako-control")
    const cli = fileURLToPath(new URL("./control-cli.js", import.meta.url))
    await writeFile(
      command,
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport MAKO_CONTROL_SESSION_FILE=${quote(sessionFile)}\nexec ${quote(executable)} ${quote(cli)} "$@"\n`,
      { mode: 0o700, flag: "wx" }
    )
    void exit
      .then(() => rm(directory, { recursive: true, force: true }))
      .catch(() => {})
    return {
      launch: { bin: directory, command, sessionFile } satisfies ControlLaunch,
      pid: child.pid,
      exited: exit,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
