import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { createControlSession } from "./control-session.js"
import { serveControlSession } from "./control-session-server.js"
import { browserControlClient } from "./browser-control-client.js"
import {
  DesktopSessionMessageSchema,
  type DesktopSessionConfig,
} from "./desktop-session-config.js"

let ownedDirectory: string | undefined
let transport: Awaited<ReturnType<typeof serveControlSession>> | undefined
let initializing: Promise<void> | undefined
let stopping: Promise<void> | undefined
async function start(config: DesktopSessionConfig, directory: string) {
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
  try {
    transport = await serveControlSession(session, {
      directory,
      onStop: () => {
        void stop()
      },
    })
    if (!stopping && process.connected)
      process.send?.({ kind: "ready", file: transport.file })
  } catch (error) {
    await session.close()
    throw error
  }
}
function stop(): Promise<void> {
  return (stopping ??= (async () => {
    const deadline = setTimeout(() => process.exit(1), 15_000)
    try {
      await initializing?.catch(() => {})
      await transport?.close()
    } finally {
      if (ownedDirectory)
        await rm(ownedDirectory, { recursive: true, force: true })
      clearTimeout(deadline)
      if (process.connected) process.disconnect()
    }
  })())
}
process.on("message", (raw) => {
  const message = DesktopSessionMessageSchema.safeParse(raw)
  if (!message.success) {
    void stop()
    return
  }
  if (message.data.kind === "stop") {
    void stop()
    return
  }
  if (initializing || stopping) return
  initializing = start(message.data.config, message.data.directory)
  void initializing.catch(() => {
    if (process.connected) process.send?.({ kind: "failed" }, () => {})
    process.exitCode = 1
    void stop()
  })
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
