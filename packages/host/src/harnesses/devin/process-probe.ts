import { z } from "zod"
import { hostProbe } from "../../base/host-command.js"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../../threads/index.js"
import { onWindows } from "../../base/platform.js"

/** `ps` reports start times to the second. */
const START_SLACK_MS = 2_000
const MAX_LOCKS = 100_000
const PrintedOnExitSchema = z.object({ code: z.literal(1), stdout: z.string() })

export interface DevinProcess {
  pid: number
  startedAt: number
}

/** Devin processes in `ps -axo pid=,lstart=,comm=` output run under the C locale. */
export function parseDevinProcesses(output: string): DevinProcess[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line)
    if (!match || basename(match[3]!.trim()) !== "devin") return []
    const startedAt = Date.parse(match[2]!)
    return Number.isFinite(startedAt) ? [{ pid: Number(match[1]), startedAt }] : []
  })
}

/**
 * The running `devin` processes: `pgrep` first, which prints nothing on a Mac with none, and only then `ps` for when
 * they started, of those pids alone. A full `ps -ax` every 5 s for a Devin nobody ran held the host's loop 2.5 s in a
 * 600 s run (2026-11-12).
 */
async function runningDevins(signal: AbortSignal): Promise<DevinProcess[]> {
  const found = await printed(hostProbe("pgrep", ["-x", "devin"], { timeout: 2_000, signal }))
  const pids = found.split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (!pids.length) return []
  const stdout = await printed(hostProbe("ps", ["-o", "pid=,lstart=,comm=", "-p", pids.join(",")], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
    timeout: 2_000,
    signal,
  }))
  return parseDevinProcesses(stdout)
}

/** What a probe printed; each exits 1 when nothing matches (pgrep for no devin, ps for a pid ended since), and what it printed holds. */
async function printed(probe: Promise<{ stdout: string }>): Promise<string> {
  try {
    return (await probe).stdout
  } catch (error) {
    const matched = PrintedOnExitSchema.safeParse(error)
    if (matched.success) return matched.data.stdout
    throw error
  }
}

function lockedBy(text: string): number | undefined {
  const pid = Number(text.trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Devin writes the pid of the process that opens or loads a session to
 * `session_locks/<session id>.lock` and never removes it, so thousands of
 * stale locks accumulate (verified with Devin CLI 2026-10-01). A session is
 * open when its lock names a running `devin` that started before the lock was
 * written; a recycled pid fails that order. Locks are only scanned while a
 * Devin process runs, and a lock is re-read only when its time changes.
 */
export function createDevinProcessProbe({
  locks = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "devin", "cli", "session_locks"),
  processes = runningDevins,
}: {
  locks?: string
  processes?: (signal: AbortSignal) => Promise<DevinProcess[]>
} = {}): ProviderProcessProbe {
  let read = new Map<string, { mtimeMs: number; pid: number | undefined }>()
  return {
    provider: "devin",
    pollIntervalMs: 5_000,
    staleAfterMs: 15_000,
    async probe(signal) {
      if (onWindows()) return { kind: "unavailable", reason: "unsupported" }
      try {
        const running = await processes(signal)
        if (!running.length) {
          read = new Map()
          return { kind: "available", sessions: [] }
        }
        const started = new Map(running.map((devin) => [devin.pid, devin.startedAt]))
        const oldest = Math.min(...started.values()) - START_SLACK_MS
        let names: string[]
        try {
          names = await readdir(locks)
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return { kind: "available", sessions: [] }
          throw error
        }
        if (names.length > MAX_LOCKS) return { kind: "unavailable", reason: "failed" }
        const next = new Map<string, { mtimeMs: number; pid: number | undefined }>()
        const sessions: ProviderActivitySession[] = []
        for (let offset = 0; offset < names.length; offset += 16) {
          signal.throwIfAborted()
          await Promise.all(names.slice(offset, offset + 16).map(async (name) => {
            if (!name.endsWith(".lock")) return
            const path = join(locks, name)
            const info = await stat(path)
            if (info.size > 64) throw new Error("Devin's lock exceeds the read limit")
            const mtimeMs = info.mtimeMs
            if (mtimeMs === undefined || mtimeMs < oldest) return
            let lock = read.get(name)
            if (lock?.mtimeMs !== mtimeMs) {
              const text = await readFile(path, { encoding: "utf8", signal })
              lock = { mtimeMs, pid: lockedBy(text) }
              if (lock.pid === undefined) throw new Error("Devin's lock is unreadable")
            }
            next.set(name, lock)
            const startedAt = lock.pid === undefined ? undefined : started.get(lock.pid)
            if (startedAt !== undefined && mtimeMs >= startedAt - START_SLACK_MS)
              sessions.push({ nativeId: name.slice(0, -".lock".length), status: "open" })
          }))
        }
        read = next
        return { kind: "available", sessions }
      } catch {
        return { kind: "unavailable", reason: signal.aborted ? "timeout" : "failed" }
      }
    },
  }
}

