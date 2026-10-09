import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { Server, Socket } from "node:net"
import { createControlSession } from "./control-session.js"
import { serveHandedControlSession } from "./control-session-server.js"
import { controlSessionBuild, type SessionDescriptor } from "./control-session-protocol.js"
import { browserControlClient } from "./browser-control-client.js"
import {
  DesktopSessionMessageSchema,
  type DesktopSessionConfig,
} from "./desktop-session-config.js"

let ownedDirectory: string | undefined
let transport: ReturnType<typeof serveHandedControlSession> | undefined
let stopping: Promise<void> | undefined

function bind(config: DesktopSessionConfig, descriptor: SessionDescriptor, directory: string, listener: Server) {
  ownedDirectory = dirname(directory)
  const environment = config.browser
    ? {
        MAKO_CONTROL_URL: config.browser.url,
        MAKO_CONTROL_TOKEN: config.browser.token,
      }
    : {}
  const session = createControlSession(
    config.native
      ? {
          command: config.native.driver,
          args: ["mcp", "--embedded", "--socket", config.native.socket],
          env: {
            ...process.env,
            CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
            CUA_DRIVER_REQUIRE_FOCUSED_TARGET: "1",
          },
        }
      : undefined,
    config.taskId,
    undefined,
    {
      artifacts: config.artifacts,
      browserCall: config.browser
        ? browserControlClient(environment)
        : undefined,
      previewEnvironment: environment,
    }
  )
  transport = serveHandedControlSession(session, {
    descriptor,
    listener,
    onStop: () => {
      void stop()
    },
  })
  if (!stopping && process.connected) process.send?.({ kind: "ready" })
}

function stop(): Promise<void> {
  return (stopping ??= (async () => {
    const deadline = setTimeout(() => process.exit(1), 15_000)
    try {
      await transport?.close()
    } finally {
      if (ownedDirectory)
        await rm(ownedDirectory, { recursive: true, force: true })
      clearTimeout(deadline)
      if (process.connected) process.disconnect()
    }
  })())
}

process.on("message", (raw, handle) => {
  const message = DesktopSessionMessageSchema.safeParse(raw)
  if (!message.success) {
    void stop()
    return
  }
  const { data } = message
  if (data.kind === "stop") {
    void stop()
    return
  }
  if (data.kind === "connection") {
    if (handle instanceof Socket) transport?.accept(handle)
    return
  }
  if (transport || stopping || !(handle instanceof Server)) return
  try {
    bind(data.config, data.descriptor, data.directory, handle)
  } catch {
    if (process.connected) process.send?.({ kind: "failed" }, () => {})
    process.exitCode = 1
    void stop()
  }
})
process.once("disconnect", () => {
  void stop()
})
process.once("SIGTERM", () => {
  void stop()
})
process.once("SIGINT", () => {
  void stop()
})
void controlSessionBuild().then(
  (build) => process.send?.({ kind: "loaded", build }),
  () => {
    process.exitCode = 1
    void stop()
  }
)
