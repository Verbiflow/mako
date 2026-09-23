import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createControlSession } from "./control-session.js"
import { serveControlSession } from "./control-session-server.js"
import { createComputerToolsServer } from "./computer-tools-main.js"
import { BrowserService } from "./browser-service.js"
import {
  CloudWorkerMessageSchema,
  type CloudControlConfig,
  type CloudParentMessage,
} from "./cloud-control-config.js"
import {
  connectMcpComputerDriver,
  type ComputerDriverProcess,
} from "./computer-driver-client.js"

// Every child inherits this worker's process group. The outer launcher owns the
// group; this worker watches its IPC lifetime in return, including parent SIGKILL.
const children: Array<{ name: string; child: ChildProcess }> = []
let config: CloudControlConfig | undefined
let runtime: string | undefined = process.env.TMPDIR
let stopping: Promise<void> | undefined
let requestedStop: string | undefined
let server: { close(): Promise<void> } | undefined
let sessionMode = false
let browsers: BrowserService | undefined
let initializing: Promise<void> | undefined
const abort = new AbortController()
const owner = "cloud-job"
const events: Array<{
  event: string
  at: number
  backend?: string
  pid?: number
}> = []
const record = (event: string, backend?: string, pid?: number) =>
  events.push({ event, at: Date.now(), backend, pid })
const send = (message: CloudParentMessage) => {
  if (process.connected) process.send?.(message, () => {})
}

function start(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  extraPipe = false
) {
  abort.signal.throwIfAborted()
  const child = spawn(command, args, {
    env,
    stdio: extraPipe
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"],
  })
  children.push({ name, child })
  record("spawn", name, child.pid)
  let diagnostics = ""
  child.stderr?.on("data", (data: Buffer) => {
    diagnostics = (diagnostics + data.toString()).slice(-8192)
  })
  child.stdout?.on("data", () => {})
  const failed = () => {
    if (config)
      void writeFile(join(config.output, `${name}.log`), diagnostics, {
        mode: 0o600,
      }).catch(() => {})
    if (!requestedStop) void shutdown(`${name}-exited`)
  }
  child.once("error", failed)
  child.once("exit", failed)
  return child
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + config!.startupMs
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted()
    const value = await read()
    if (value !== undefined) return value
    await delay(25, undefined, { signal: abort.signal })
  }
  throw new Error("Backend readiness deadline exceeded")
}
async function textFrom(child: ChildProcess, fd: number): Promise<string> {
  let text = ""
  const pipe = child.stdio[fd]
  if (!pipe || !("on" in pipe)) throw new Error("Readiness pipe unavailable")
  pipe.on("data", (bytes: Buffer) => {
    text = (text + bytes.toString()).slice(-8192)
  })
  return until(async () =>
    text.includes("\n") ? text.split("\n")[0].trim() : undefined
  )
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
async function initialize(current: CloudControlConfig, directory: string, sessionTransport = false) {
  sessionMode = sessionTransport
  config = current
  runtime = directory
  process.env.MAKO_CONTROL_ARTIFACTS = current.output
  const home = join(directory, "home")
  await mkdir(home, { mode: 0o700 })
  Object.assign(process.env, {
    HOME: home,
    XDG_RUNTIME_DIR: directory,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    CUA_DRIVER_REQUIRE_FOCUSED_TARGET: "1",
    NO_AT_BRIDGE: "0",
    GTK_MODULES: "gail:atk-bridge",
  })
  let backend: ComputerDriverProcess | undefined
  if (current.native) {
    // Private session bus and authenticated X server; nothing is borrowed from a
    // logged-in desktop. Xvfb allocates the display number atomically.
    const bus = start("dbus", "/usr/bin/dbus-daemon", [
      "--session",
      "--nofork",
      "--print-address=1",
      `--address=unix:path=${directory}/bus`,
    ])
    process.env.DBUS_SESSION_BUS_ADDRESS = await textFrom(bus, 1)
    const authority = join(directory, "Xauthority")
    const cookie = randomBytes(16).toString("hex")
    // Xauthority wildcard-family entry works with Xvfb's allocated display.
    const field = (data: Buffer) => {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(data.length)
      return Buffer.concat([length, data])
    }
    await writeFile(
      authority,
      Buffer.concat([
        Buffer.from([255, 255]),
        field(Buffer.alloc(0)),
        field(Buffer.alloc(0)),
        field(Buffer.from("MIT-MAGIC-COOKIE-1")),
        field(Buffer.from(cookie, "hex")),
      ]),
      { mode: 0o600 }
    )
    process.env.XAUTHORITY = authority
    const x = start(
      "display",
      "/usr/bin/Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        "1280x900x24",
        "-nolisten",
        "tcp",
        "-auth",
        authority,
      ],
      process.env,
      true
    )
    const display = await textFrom(x, 3)
    if (!/^\d+$/.test(display))
      throw new Error("X server returned an invalid display")
    process.env.DISPLAY = `:${display}`
    await writeFile(
      authority,
      Buffer.concat([
        Buffer.from([255, 255]),
        field(Buffer.alloc(0)),
        field(Buffer.from(display)),
        field(Buffer.from("MIT-MAGIC-COOKIE-1")),
        field(Buffer.from(cookie, "hex")),
      ]),
      { mode: 0o600 }
    )
    const marker = join(directory, "wm-ready")
    start("window-manager", "/usr/bin/openbox", [
      "--startup",
      `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready')`)}`,
    ])
    await until(async () =>
      access(marker).then(
        () => true,
        () => undefined
      )
    )
    const socket = join(directory, "driver.sock")
    // The trusted job config authorizes control inside this disposable desktop;
    // this does not change the desktop application's permission policy.
    start("driver", current.native.driver, [
      "serve",
      "--no-overlay",
      "--dangerously-bypass-approvals",
      "--socket",
      socket,
    ])
    await until(async () =>
      access(socket).then(
        () => true,
        () => undefined
      )
    )
    backend = {
      command: current.native.driver,
      args: ["mcp", "--socket", socket],
      env: { ...process.env, CUA_DRIVER_PERMISSION_MODE: "unrestricted" },
    }
    const probe = await connectMcpComputerDriver(backend)
    try {
      await probe.listTools()
    } finally {
      await probe.close()
    }
  }
  if (current.browser) {
    const profile = join(directory, "chromium")
    await mkdir(profile, { mode: 0o700 })
    start("browser", current.browser.executable, [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(current.browser.sandbox ? [] : ["--no-sandbox"]),
      "about:blank",
    ])
    const endpoint = await until(async () => {
      const lines = await readFile(
        join(profile, "DevToolsActivePort"),
        "utf8"
      ).catch(() => "")
      const [port, path] = lines.trim().split("\n")
      if (!/^\d+$/.test(port ?? "") || !path?.startsWith("/devtools/browser/"))
        return undefined
      return `ws://127.0.0.1:${port}${path}`
    })
    browsers = new BrowserService([
      {
        id: "cloud",
        name: "Job browser",
        transport: "direct",
        kind: "chromium",
        requiresApproval: false,
        endpoint: async () => endpoint,
      },
    ])
    await browsers.connect("cloud")
    await browsers.prefer("cloud")
  }
  abort.signal.throwIfAborted()
  const browserCall = browsers
    ? Object.assign(
        (
          command: Parameters<BrowserService["execute"]>[1],
          signal: AbortSignal
        ) =>
          browsers!.execute(
            owner,
            command,
            AbortSignal.any([signal, abort.signal])
          ),
        {
          close: async () => {
            await browsers!.releaseOwner(owner, { finalizeRecordings: true })
          },
        }
      )
    : undefined
  const options = {
    browserCall,
    onProgramCancelled: () => { void shutdown("request-cancelled") },
  }
  if (sessionTransport) {
    const engine = createControlSession(backend, owner, undefined, options)
    const transport = await serveControlSession(engine, { onStop: () => { void shutdown("session-stop") } })
    server = transport
    const sessionFile = join(current.output, ".session.json")
    await writeFile(sessionFile, JSON.stringify(transport.descriptor) + "\n", { mode: 0o600, flag: "wx" })
    await rename(sessionFile, join(current.output, "session.json"))
  } else {
    const mcp = createComputerToolsServer(backend, owner, undefined, { ...options, cli: true })
    server = mcp
    await mcp.connect(new StdioServerTransport())
  }
  record("ready")
  await writeFile(
    join(current.output, "ready.json"),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      backends: children.map(({ name, child }) => ({ name, pid: child.pid })),
    }),
    { mode: 0o600 }
  )
  send({ kind: "ready" })
}
function shutdown(reason: string): Promise<void> {
  requestedStop ??= reason
  abort.abort(new Error(requestedStop))
  return (stopping ??= (async () => {
    // Fatal worker hangs are bounded even if the outer launcher was SIGKILLed.
    const emergency = setTimeout(
      () => {
        process.kill(-process.pid, "SIGKILL")
      },
      (config?.shutdownMs ?? 30_000) + 500
    )
    await initializing?.catch(() => {})
    let clean = true
    try {
      await server?.close()
      if (!server)
        await browsers?.releaseOwner(owner, { finalizeRecordings: true })
    } catch {
      clean = false
    }
    browsers?.close()
    for (const { child } of [...children].reverse())
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM")
    await Promise.all(
      children.map(async ({ child }) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          delay(1000),
        ])
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL")
      })
    )
    record("stopped")
    if (runtime) await rm(runtime, { recursive: true, force: true })
    if (config) {
      const path = join(config.output, "worker.json")
      await writeFile(
        `${path}.tmp`,
        JSON.stringify(
          { version: 1, reason: requestedStop, clean, events },
          null,
          2
        ),
        { mode: 0o600 }
      )
      await rename(`${path}.tmp`, path)
    }
    send({ kind: "finished", clean, reason: requestedStop! })
    clearTimeout(emergency)
    // If the parent died, no outer reaper remains to remove grandchildren.
    if (!process.connected) process.kill(-process.pid, "SIGKILL")
    else
      process.exit(
        clean &&
          [
            "stdin-eof",
            "session-stop",
            "SIGTERM",
            "SIGINT",
            "deadline",
            "request-cancelled",
            "launcher-disconnected",
          ].includes(requestedStop!)
          ? 0
          : 1
      )
  })())
}
if (!process.send)
  throw new Error("The cloud worker must be started by its launcher")
process.on("message", (raw) => {
  const message = CloudWorkerMessageSchema.parse(raw)
  if (message.kind === "stop") void shutdown(message.reason)
  else if (!initializing && !requestedStop) {
    initializing = initialize(message.config, message.runtime, message.session)
    void initializing.catch((error) => {
      record(error instanceof Error ? error.name : "startup-error")
      void shutdown("startup-failed")
    })
  }
})
process.once("disconnect", () => {
  void shutdown("launcher-disconnected")
})
process.once("SIGTERM", () => {
  void shutdown("SIGTERM")
})
process.once("SIGINT", () => {
  void shutdown("SIGINT")
})
process.stdin.once("end", () => {
  if (!sessionMode) void shutdown("stdin-eof")
})
