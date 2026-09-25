import { type ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { hostLog, hostWarn } from "./host-log.js"
import {
  processExecutableMatches,
  processIdentityMatches,
  observeProcessIdentity,
  processStartMatches,
} from "./providers/process-liveness.js"

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
  processStartedAt: z.number().optional(),
  executable: z.string(),
  executableIdentity: z.string().optional(),
  kind: z.string(),
  owner: z.string(),
  host: z.number().int().positive(),
})
const RegistrySchema = z.object({ children: z.array(RecordSchema) })
export type ProviderChildRecord = z.infer<typeof RecordSchema>

export class ProviderChildren {
  readonly path: string
  private records: ProviderChildRecord[] = []
  private readonly hostPid: number
  private readonly observeIdentity: typeof observeProcessIdentity
  private reaped = false
  private readonly observations = new Map<number, AbortController>()

  constructor(
    dataRoot: string,
    hostPid = process.pid,
    observeIdentity = observeProcessIdentity
  ) {
    this.path = join(dataRoot, "runtime", "provider-children.json")
    this.hostPid = hostPid
    this.observeIdentity = observeIdentity
  }

  /** What an earlier host left behind: every record not written by this host. */
  private read(): ProviderChildRecord[] {
    try {
      return RegistrySchema.parse(JSON.parse(readFileSync(this.path, "utf8")))
        .children
    } catch {
      return []
    }
  }

  /** This host's records replace only its own; another host's stay until reaped. */
  private write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const foreign = this.reaped
        ? []
        : this.read().filter((entry) => entry.host !== this.hostPid)
      const draft = `${this.path}.${this.hostPid}.tmp`
      writeFileSync(
        draft,
        JSON.stringify({ children: [...foreign, ...this.records] }),
        { mode: 0o600 }
      )
      renameSync(draft, this.path)
    } catch (error) {
      hostWarn("children", "registry write failed", {
        error: error instanceof Error ? error.message : String(error),
      })
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
   * Record a newly spawned PID immediately. Identity observation checks its
   * birth against this timestamp; callers cannot adopt an arbitrary older PID.
   * Prefer track(child), which also removes the record on exit.
   */
  trackPid(info: {
    pid: number
    executable: string
    kind: string
    owner: string
  }): void {
    const record: ProviderChildRecord = {
      pid: info.pid,
      startedAt: Date.now(),
      executable: info.executable,
      kind: info.kind,
      owner: info.owner,
      host: this.hostPid,
    }
    this.records = [
      ...this.records.filter((entry) => entry.pid !== info.pid),
      record,
    ]
    this.write()
    this.observations.get(info.pid)?.abort()
    const controller = new AbortController()
    this.observations.set(info.pid, controller)
    void this.observe(record, controller).finally(() => {
      if (this.observations.get(info.pid) === controller)
        this.observations.delete(info.pid)
    })
  }

  private async observe(
    record: ProviderChildRecord,
    controller: AbortController
  ): Promise<void> {
    // One observation at a time per child; slow lsof must never block host IPC.
    // Later observations follow exec wrappers without granting a recycled PID ownership.
    for (const wait of [0, 250, 1_000, 5_000]) {
      try {
        if (wait)
          await delay(wait, undefined, {
            signal: controller.signal,
            ref: false,
          })
        if (controller.signal.aborted || !this.records.includes(record)) return
        const identity = await this.observeIdentity(
          record.pid,
          AbortSignal.any([controller.signal, AbortSignal.timeout(4_500)])
        )
        if (controller.signal.aborted || !this.records.includes(record)) return
        if (
          !processStartMatches(
            record.processStartedAt ?? record.startedAt,
            identity.startedAt,
            record.processStartedAt === undefined ? 1_500 : 0
          )
        )
          return
        if (
          record.processStartedAt === identity.startedAt &&
          record.executableIdentity === identity.executable
        )
          continue
        record.processStartedAt = identity.startedAt
        record.executableIdentity = identity.executable
        this.write()
      } catch {
        // An unavailable OS observation cannot authorize cleanup or an identity change.
        if (controller.signal.aborted) return
      }
    }
  }

  untrackPid(pid: number): void {
    this.observations.get(pid)?.abort()
    this.observations.delete(pid)
    if (!this.records.some((entry) => entry.pid === pid)) return
    this.records = this.records.filter((entry) => entry.pid !== pid)
    this.write()
  }

  /**
   * Terminate what an earlier host left. Only a pid that still runs the
   * recorded executable and started within the record's tolerance is
   * signalled; anything else is dropped from the registry as already gone.
   */
  async reap(
    signal: AbortSignal = AbortSignal.timeout(10_000)
  ): Promise<ProviderChildRecord[]> {
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
        hostWarn("children", "orphan not terminated", {
          pid: entry.pid,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.reaped = true
    this.write()
    return killed
  }

  private async identityHolds(
    entry: ProviderChildRecord,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      if (
        !(await processIdentityMatches({
          pid: entry.pid,
          startedAt: entry.processStartedAt ?? entry.startedAt,
          signal,
          exact: entry.processStartedAt !== undefined,
          toleranceMs: entry.processStartedAt === undefined ? 1_500 : undefined,
        }))
      )
        return false
      return processExecutableMatches({
        pid: entry.pid,
        executable:
          entry.executableIdentity ??
          (await legacyShebangExecutable(entry.executable)) ??
          entry.executable,
        signal,
      })
    } catch {
      return false
    }
  }
}

async function legacyShebangExecutable(
  executable: string
): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(executable, "r")
    const { buffer, bytesRead } = await file.read(Buffer.alloc(512), 0, 512, 0)
    const line = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]
    if (!line?.startsWith("#!")) return undefined
    const command = line.slice(2).trim().split(/\s+/)
    if (basename(command[0] ?? "") !== "env") return command[0]
    return command
      .slice(1)
      .find((argument) => !argument.startsWith("-") && !argument.includes("="))
  } catch {
    return undefined
  } finally {
    await file?.close()
  }
}

let active: ProviderChildren | null = null

export function installProviderChildren(dataRoot: string): ProviderChildren {
  active = new ProviderChildren(dataRoot)
  return active
}

export function trackProviderChild(
  child: ChildProcess,
  info: { kind: string; owner: string }
): void {
  active?.track(child, info)
}

export function untrackProviderPid(pid: number): void {
  active?.untrackPid(pid)
}
