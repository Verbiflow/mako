#!/usr/bin/env -S node --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED --heap-growing-percent=30
import { forgetStartingRepository } from "@mako/git/environment"
import { enableMainCompileCache } from "./base/compile-cache.js"

/**
 * `mako-host`, the program: the host itself, or `mako-host inspect` to read
 * a running one. The same build runs under Electron's Helper in Node mode on
 * a Mac (the desktop's entry imports this) and under Node on Linux, where it
 * is the package's executable. The host is configured by its environment
 * (`host-config.ts`), as `ensureRuntime` and a machine's agent start it.
 * `join`, `status` and `leave` make a machine with no browser a device of its
 * person's account (`usage/device-cli.ts`).
 */
const USAGE = `Usage:
  mako-host            run the host; MAKO_DATA_ROOT for data outside the default, MAKO_WEB_SOCKET for its socket elsewhere
  mako-host inspect    what a running host has loaded and runs (mako-host inspect --help)
  mako-host join       add this machine to your Mako account with a code (mako-host join --help)
  mako-host status     this machine's device, account and links
  mako-host leave      sign this machine out and remove it from the account`

const [command, ...args] = process.argv.slice(2)
if (command === "inspect") {
  const { inspectHost } = await import("./inspect.js")
  process.exitCode = await inspectHost(args)
} else if (command === "join" || command === "status" || command === "leave") {
  const { loadDeviceCommands } = await import("./usage/index.js")
  process.exitCode = await (await loadDeviceCommands()).deviceCommand(command, args)
} else if (command === undefined) {
  // Children set Node mode themselves; a terminal's shell must not start Electron apps as Node.
  delete process.env.ELECTRON_RUN_AS_NODE
  forgetStartingRepository()
  // The cache is per data root, and must be on before the host's modules load.
  const { processHostEnvironment } = await import("./base/host-environment.js")
  const { dataRoot } = processHostEnvironment()
  const cache = enableMainCompileCache(dataRoot)
  if (cache.startsWith("failed")) console.warn("[mako-host] compile cache", cache)
  // Started by hand, as on a server: on the socket `inspect` and `status` look for, against the cloud it joined.
  if (!process.env.MAKO_WEB_SOCKET) {
    const { runtimeLocation } = await import("./transport/index.js")
    process.env.MAKO_WEB_SOCKET = runtimeLocation(dataRoot).socket
  }
  if (!process.env.MAKO_CLOUD_URL) {
    const { readJoinedCloud } = await import("./base/joined-cloud.js")
    const joined = readJoinedCloud(dataRoot)
    if (joined) process.env.MAKO_CLOUD_URL = joined
  }
  await import("./host-main.js")
} else if (command === "--help" || command === "help") {
  console.log(USAGE)
} else {
  console.error(`mako-host: unknown command ${command}\n${USAGE}`)
  process.exitCode = 64
}
