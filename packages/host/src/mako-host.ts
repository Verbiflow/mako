#!/usr/bin/env node
import { forgetStartingRepository } from "@mako/git/environment"
import { enableMainCompileCache } from "./base/compile-cache.js"

/**
 * `mako-host`, the program: the host itself, or `mako-host inspect` to read
 * a running one. The same build runs under Electron's Helper in Node mode on
 * a Mac (the desktop's entry imports this) and under Node on Linux, where it
 * is the package's executable. The host is configured by its environment
 * (`host-config.ts`), as `ensureRuntime` and a machine's agent start it.
 */
const USAGE = `Usage:
  mako-host            run the host; it needs MAKO_WEB_SOCKET, and MAKO_DATA_ROOT for data outside the default
  mako-host inspect    what a running host has loaded and runs (mako-host inspect --help)`

const [command, ...args] = process.argv.slice(2)
if (command === "inspect") {
  const { inspectHost } = await import("./inspect.js")
  process.exitCode = await inspectHost(args)
} else if (command === undefined) {
  // Children set Node mode themselves; a terminal's shell must not start Electron apps as Node.
  delete process.env.ELECTRON_RUN_AS_NODE
  forgetStartingRepository()
  // The cache is per data root, and must be on before the host's modules load.
  const { processHostEnvironment } = await import("./base/host-environment.js")
  const cache = enableMainCompileCache(processHostEnvironment().dataRoot)
  if (cache.startsWith("failed")) console.warn("[mako-host] compile cache", cache)
  await import("./host-main.js")
} else if (command === "--help" || command === "help") {
  console.log(USAGE)
} else {
  console.error(`mako-host: unknown command ${command}\n${USAGE}`)
  process.exitCode = 64
}
