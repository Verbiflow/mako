import { execFile } from "node:child_process"
import { readlink, realpath } from "node:fs/promises"
import { basename, isAbsolute } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const START_TOLERANCE_MS = 30_000

async function processStartedAt(
  pid: number,
  signal: AbortSignal
): Promise<number> {
  const { stdout } = await run("ps", ["-p", String(pid), "-o", "lstart="], {
    maxBuffer: 4_096,
    timeout: 1_500,
    signal,
  })
  const actual = Date.parse(stdout.trim())
  if (!Number.isFinite(actual))
    throw new Error("Process start time is unreadable")
  return actual
}

async function processExecutables(
  pid: number,
  signal: AbortSignal
): Promise<string[]> {
  if (process.platform === "linux") return [await readlink(`/proc/${pid}/exe`)]
  if (process.platform === "darwin") {
    const { stdout } = await run(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"],
      { maxBuffer: 64_000, timeout: 1_500, signal }
    )
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1))
  }
  throw new Error("Process executable identity is unavailable on this platform")
}

/** Bracket the executable read so a recycled PID cannot acquire an old record. */
export async function observeProcessIdentity(pid: number, signal: AbortSignal) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "Process executable identity is unavailable on this platform"
    )
  const startedAt = await processStartedAt(pid, signal)
  const executable = (await processExecutables(pid, signal))[0]
  if (!executable || basename(executable) === "env")
    throw new Error("Process executable identity is not ready")
  if ((await processStartedAt(pid, signal)) !== startedAt)
    throw new Error("Process identity changed during observation")
  return {
    startedAt,
    executable: await realpath(executable).catch(() => executable),
  }
}

export function processStartMatches(
  expected: number | string | undefined,
  actual: number,
  toleranceMs = START_TOLERANCE_MS
): boolean {
  if (expected === undefined) return true
  const numeric = Object.prototype.toString.call(expected) === "[object Number]"
  const parsed = numeric
    ? Number(expected) < 1_000_000_000_000
      ? Number(expected) * 1_000
      : Number(expected)
    : Date.parse(String(expected))
  return Number.isFinite(parsed) && Math.abs(parsed - actual) <= toleranceMs
}

export async function processIdentityMatches({
  pid,
  startedAt,
  signal,
  exact = false,
  toleranceMs,
}: {
  pid: number
  startedAt?: number | string
  signal: AbortSignal
  exact?: boolean
  toleranceMs?: number
}): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false
    throw error
  }
  if (startedAt === undefined) return true
  if (process.platform === "win32")
    throw new Error("Process start identity is unavailable on this platform")
  const actual = await processStartedAt(pid, signal)
  return processStartMatches(
    startedAt,
    actual,
    toleranceMs ?? (exact ? 0 : START_TOLERANCE_MS)
  )
}

function executableMatches(expected: string, actual: string): boolean {
  return isAbsolute(expected)
    ? actual === expected
    : basename(actual) === basename(expected)
}

/**
 * Resolve executable identity independently of argv. Node's `process.title`
 * overwrites both `ps command` and `ps comm` on macOS, so either field can
 * make an orphan look unrelated to the executable Mako actually spawned.
 */
export async function processExecutableMatches({
  pid,
  executable,
  signal,
}: {
  pid: number
  executable: string
  signal: AbortSignal
}): Promise<boolean> {
  const expected = await realpath(executable).catch(() => executable)
  if (process.platform === "linux" || process.platform === "darwin") {
    try {
      return (await processExecutables(pid, signal)).some((executable) =>
        executableMatches(expected, executable)
      )
    } catch {
      return false
    }
  }
  throw new Error("Process executable identity is unavailable on this platform")
}
