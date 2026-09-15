import type { ChildProcess } from "node:child_process"
import { execFile } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { hostLog, hostWarn } from "./host-log.js"
import { processIdentityMatches } from "./providers/process-liveness.js"

/**
 * Provider processes the host has spawned and would otherwise orphan.
 *
 * A quit runs `stopAcp()` and the rest of cleanup, but a host that is killed,
 * crashes, or is replaced under an installer never reaches it, and its ACP
 * and app-server children keep running with their pipes attached to nothing.
 * Four idle cursor-agent processes from three earlier hosts were found a day
 * later, holding 600 MB between them. So every spawn is written here first,
 * removed on exit, and the next host to start reads what was left and
 * terminates it, after checking that the pid still runs the same executable
 * and started when the record says it did. A reused pid is never killed.
 */
const RecordSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.number(),
  executable: z.string(),
  kind: z.string(),
  owner: z.string(),
  host: z.number().int().positive(),
})
const RegistrySchema = z.object({ children: z.array(RecordSchema) })
export type ProviderChildRecord = z.infer<typeof RecordSchema>

const run = promisify(execFile)

export class ProviderChildren {
  readonly path: string
  private records: ProviderChildRecord[] = []
  private readonly hostPid: number
  private reaped = false

  constructor(dataRoot: string, hostPid = process.pid) {
    this.path = join(dataRoot, "runtime", "provider-children.json")
    this.hostPid = hostPid
  }

  /** What an earlier host left behind: every record not written by this host. */
  private read(): ProviderChildRecord[] {
    try {
      return RegistrySchema.parse(JSON.parse(readFileSync(this.path, "utf8"))).children
    } catch {
      return []
    }
  }

  /** This host's records replace only its own; another host's stay until reaped. */
  private write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const foreign = this.reaped ? [] : this.read().filter((entry) => entry.host !== this.hostPid)
      const draft = `${this.path}.${this.hostPid}.tmp`
      writeFileSync(draft, JSON.stringify({ children: [...foreign, ...this.records] }), { mode: 0o600 })
      renameSync(draft, this.path)
    } catch (error) {
      hostWarn("children", "registry write failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Record a spawned provider process until it exits. */
  track(child: ChildProcess, info: { kind: string; owner: string }): void {
    const pid = child.pid
    if (!pid) return
    this.trackPid({ pid, executable: child.spawnfile, ...info })
    child.once("exit", () => this.untrackPid(pid))
  }

  /**
   * Record a process the host did not spawn itself but is responsible for:
   * the native driver started through LaunchServices, whose pid is found
   * after the fact. The caller removes it when it stops the process.
   */
  trackPid(info: { pid: number; executable: string; kind: string; owner: string }): void {
    const record: ProviderChildRecord = {
      pid: info.pid,
      startedAt: Date.now(),
      executable: info.executable,
      kind: info.kind,
      owner: info.owner,
      host: this.hostPid,
    }
    this.records = [...this.records.filter((entry) => entry.pid !== info.pid), record]
    this.write()
  }

  untrackPid(pid: number): void {
    if (!this.records.some((entry) => entry.pid === pid)) return
    this.records = this.records.filter((entry) => entry.pid !== pid)
    this.write()
  }

  /**
   * Terminate what an earlier host left. Only a pid that still runs the
   * recorded executable and started within the record's tolerance is
   * signalled; anything else is dropped from the registry as already gone.
   */
  async reap(signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<ProviderChildRecord[]> {
    const leftovers = this.read().filter((entry) => entry.host !== this.hostPid)
    const killed: ProviderChildRecord[] = []
    for (const entry of leftovers) {
      const alive = await this.identityHolds(entry, signal)
      if (!alive) continue
      try {
        process.kill(entry.pid, "SIGTERM")
        killed.push(entry)
        hostLog("children", "terminated orphan", {
          pid: entry.pid,
          kind: entry.kind,
          owner: entry.owner,
          executable: entry.executable,
          host: entry.host,
          ageMinutes: Math.round((Date.now() - entry.startedAt) / 60_000),
        })
      } catch (error) {
        hostWarn("children", "orphan not terminated", { pid: entry.pid, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.reaped = true
    this.write()
    return killed
  }

  private async identityHolds(entry: ProviderChildRecord, signal: AbortSignal): Promise<boolean> {
    try {
      if (!(await processIdentityMatches({ pid: entry.pid, startedAt: entry.startedAt, signal }))) return false
      const { stdout } = await run("ps", ["-p", String(entry.pid), "-o", "command="], { maxBuffer: 16_384, timeout: 1_500, signal })
      return stdout.includes(entry.executable)
    } catch {
      return false
    }
  }
}

let active: ProviderChildren | null = null

export function installProviderChildren(dataRoot: string): ProviderChildren {
  active = new ProviderChildren(dataRoot)
  return active
}

export function trackProviderChild(child: ChildProcess, info: { kind: string; owner: string }): void {
  active?.track(child, info)
}

export function trackProviderPid(info: { pid: number; executable: string; kind: string; owner: string }): void {
  active?.trackPid(info)
}

export function untrackProviderPid(pid: number): void {
  active?.untrackPid(pid)
}
