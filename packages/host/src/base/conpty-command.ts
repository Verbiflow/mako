import { createRequire } from "node:module"
import { resolveExecutable } from "./executable.js"
import { windowsLaunch } from "./windows-launch.js"

/**
 * A program under a pseudo-terminal on Windows, where there is no `script`: Node runs a small bridge that starts it in
 * a ConPTY through node-pty, the terminal daemon's own, and passes its screen to stdout and stdin to its keyboard, so
 * whoever spawned the bridge reads and writes it as it would `script`. A batch file is started as `windowsLaunch` says.
 */
const BRIDGE = `
const [ptyModule, mode, file, ...rest] = process.argv.slice(1)
const pty = require(ptyModule)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const term = pty.spawn(file, mode === "line" ? rest[0] : rest, { name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env })
term.onData((data) => process.stdout.write(data))
process.stdin.on("data", (data) => term.write(data.toString("utf8")))
process.stdin.on("end", () => term.kill())
term.onExit(({ exitCode }) => process.exit(exitCode ?? 0))
`

/** A program to start, with its words and environment. */
export interface ConptyCommand {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function conptyCommand(executable: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ConptyCommand {
  const launch = windowsLaunch(executable, args, env, resolveExecutable("node", env) ?? process.execPath)
  const ptyModule = createRequire(import.meta.url).resolve("@lydell/node-pty")
  const words = launch.verbatim ? ["line", launch.file, launch.args.join(" ")] : ["words", launch.file, ...launch.args]
  // Plain Node runs the bridge even where the host is Electron's in Node mode; the bridge clears it for the program.
  return { executable: process.execPath, args: ["-e", BRIDGE, ptyModule, ...words], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }
}
