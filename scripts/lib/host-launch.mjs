import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { hostCommand } from "../../dist-electron/runtime-service.js"

/** Electron's executable, from the checkout's npm package. */
export const electronExecutable = createRequire(import.meta.url)("electron")

/**
 * Start a host as `ensureRuntime` does, as Node, for a test that needs the
 * process itself: its pid, its exit, its signals. `app` is a packaged
 * Mako.app's executable; without one, the checkout's build runs under
 * Electron's Helper. `env` carries MAKO_DATA_ROOT and MAKO_WEB_SOCKET.
 */
export function spawnHost(env, { app, cwd = resolve("."), stdio = "ignore" } = {}) {
  const command = hostCommand(app ? { executable: app, args: [], env } : { executable: electronExecutable, args: [cwd], env })
  return spawn(command.executable, command.args, { cwd, env: command.env, stdio })
}
