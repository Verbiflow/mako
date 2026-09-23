import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/** Stable enough to distinguish a reused pid; `ps lstart` is second-granular. */
function processStartCommand(pid: number): {
  file: string
  args: string[]
} {
  return process.platform === "win32"
    ? {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
      }
    : {
        file: "ps",
        args: ["-p", String(pid), "-o", "lstart="],
      }
}

function parseStartedAt(output: string): number {
  const startedAt = Date.parse(output.trim())
  if (!Number.isFinite(startedAt))
    throw new Error("Process start identity is unreadable")
  return startedAt
}

export function processRegistrationStartedAt(pid: number): number {
  process.kill(pid, 0)
  const command = processStartCommand(pid)
  const output = execFileSync(command.file, command.args, {
    encoding: "utf8",
    maxBuffer: 4_096,
    timeout: 1_500,
  }).trim()
  return parseStartedAt(output)
}

export async function registeredProcessIsCurrentAsync(
  pid: number,
  startedAt: number,
  signal: AbortSignal
): Promise<boolean> {
  try {
    process.kill(pid, 0)
    const command = processStartCommand(pid)
    const result = await run(command.file, command.args, {
      encoding: "utf8",
      maxBuffer: 4_096,
      timeout: 1_500,
      signal,
    })
    return parseStartedAt(result.stdout) === startedAt
  } catch {
    return false
  }
}

