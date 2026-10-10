import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { userInfo } from "node:os"
import { z } from "zod"

const LOGIN_PATH = "/usr/bin/login"
const BASH_PATH = "/bin/bash"
const PRINTF_PATH = "/usr/bin/printf"
const MARKER = "MAKO_LOGIN_PREFLIGHT_OK"
const TIMEOUT_MS = 750
const RETRY_MS = 5_000
const REVALIDATE_MS = 30 * 60_000
const errorSchema = z.object({ killed: z.boolean().optional() })

interface ShellCommand {
  file: string
  args: string[]
}

let accepted: boolean | null = null
let decidedAt = 0
let retryAt = 0
let inFlight: Promise<boolean> | null = null

function disabled(): boolean {
  const value = process.env.MAKO_DISABLE_MACOS_LOGIN_SHELL
  return value === "1" || value === "true"
}

function account(): { username: string; home: string } | null {
  try {
    const info = userInfo()
    return info.username && info.homedir
      ? { username: info.username, home: info.homedir }
      : null
  } catch {
    return null
  }
}

function preflight(username: string, home: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        LOGIN_PATH,
        ["-flpq", username, PRINTF_PATH, MARKER],
        {
          cwd: home,
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 1024,
          timeout: TIMEOUT_MS,
        },
        (error, stdout) => {
          if (!error) {
            resolve(stdout === MARKER)
            return
          }
          const parsed = errorSchema.safeParse(error)
          resolve(parsed.success && parsed.data.killed ? null : false)
        }
      )
      child.stdin?.end()
    } catch {
      resolve(null)
    }
  })
}

export async function prepareMacosTerminalLogin(): Promise<boolean> {
  if (
    process.platform !== "darwin" ||
    disabled() ||
    !existsSync(LOGIN_PATH)
  ) {
    return false
  }
  const now = Date.now()
  if (accepted === true) return true
  if (accepted === false && now - decidedAt < REVALIDATE_MS) return false
  if (now < retryAt) return false
  const identity = account()
  if (!identity) return false
  inFlight ??= preflight(identity.username, identity.home)
    .then((result) => {
      if (result === null) {
        retryAt = Date.now() + RETRY_MS
        return false
      }
      accepted = result
      decidedAt = Date.now()
      retryAt = 0
      return result
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

export function wrapMacosTerminalLogin(
  command: ShellCommand,
  env: NodeJS.ProcessEnv
): ShellCommand {
  if (
    process.platform !== "darwin" ||
    accepted !== true ||
    command.file === LOGIN_PATH ||
    disabled()
  ) {
    return command
  }
  const identity = account()
  if (!identity) return command
  const shell = env.SHELL || command.file
  return {
    file: LOGIN_PATH,
    args: [
      "-flpq",
      identity.username,
      BASH_PATH,
      "--noprofile",
      "--norc",
      "-p",
      "-c",
      'export SHELL="$1"; shift; exec -l -- "$@"',
      "mako-terminal-login",
      shell,
      command.file,
      ...command.args,
    ],
  }
}

export function resetMacosTerminalLoginForTests(): void {
  accepted = null
  decidedAt = 0
  retryAt = 0
  inFlight = null
}
