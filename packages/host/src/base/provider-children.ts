import type { ChildProcess } from "node:child_process"
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
} from "./process-liveness.js"
import { topic } from "./topic.js"

/**
 * Provider processes the host has spawned and would otherwise orphan.
 *
 * A quit stops every live driver and the rest of cleanup, but a host that is killed,
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
  /**
   * The native session the process holds: its id, or null when it holds none of a harness's existing sessions (a
   * discovery probe, a start ahead, a session not yet made). Absent where unknown, as in an older build's records.
   */
  session: z.string().nullable().optional(),
}).loose()
const RegistrySchema = z.object({ children: z.array(RecordSchema) })
export type ProviderChildRecord = z.infer<typeof RecordSchema>

export class ProviderChildren {
  readonly path: string
  private records: ProviderChildRecord[] = []
  private readonly hostPid: number
  private readonly observeIdentity: typeof observeProcessIdentity
  /** Retire only records proved gone or successfully signalled, never unreadable identities. */
  private readonly retired = new Set<string>()
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
      const foreign = this.read().filter(
        (entry) => entry.host !== this.hostPid && !this.retired.has(childRecordId(entry))
      )
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

  /** Record what spawners report from now on; returns what stops it. */
  follow(): () => void {
    return events.subscribe((event) => {
      if ("spawned" in event) this.trackPid(event.spawned)
      else if ("owned" in event) this.reown(event.owned)
      else if ("bound" in event) this.bind(event.bound)
      else this.untrackPid(event.exited)
    })
  }

  /** A recorded process taken over by another owner (a child spawned ahead, adopted by a session); its birth stays. */
  reown(info: { pid: number; owner: string }): void {
    if (!this.records.some((entry) => entry.pid === info.pid && entry.owner !== info.owner)) return
    this.records = this.records.map((entry) => (entry.pid === info.pid ? { ...entry, owner: info.owner } : entry))
    this.write()
  }

  /** The session a recorded process holds from now on: a session it opened, or none. */
  bind(info: { pid: number; session: string | null }): void {
    if (!this.records.some((entry) => entry.pid === info.pid && entry.session !== info.session)) return
    // Mutated in place: an identity observation in flight holds the record by reference.
    for (const entry of this.records) if (entry.pid === info.pid) entry.session = info.session
    this.write()
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
    session?: string | null
  }): void {
    const record: ProviderChildRecord = {
      pid: info.pid,
      startedAt: Date.now(),
      executable: info.executable,
      kind: info.kind,
      owner: info.owner,
      host: this.hostPid,
      ...info.session !== undefined && { session: info.session },
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
   * signalled. Unreadable or changed executable observations remain recorded;
   * only a missing process or a different birth proves the old record gone.
   */
  async reap(
    signal: AbortSignal = AbortSignal.timeout(10_000)
  ): Promise<ProviderChildRecord[]> {
    const leftovers = this.read().filter((entry) => entry.host !== this.hostPid)
    const killed: ProviderChildRecord[] = []
    for (const entry of leftovers) {
      // A foreign record is not an orphan while its host might still live.
      // Old records have no host birth identity, so a reused host PID also
      // conservatively blocks cleanup instead of authorizing a signal.
      if (!hostIsGone(entry.host)) continue
      const identity = await this.identityHolds(entry, signal)
      if (identity === "gone") this.retired.add(childRecordId(entry))
      if (identity !== "owned") continue
      try {
        process.kill(entry.pid, "SIGTERM")
        this.retired.add(childRecordId(entry))
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
    this.write()
    return killed
  }

  private async identityHolds(
    entry: ProviderChildRecord,
    signal: AbortSignal
  ): Promise<"owned" | "gone" | "unavailable"> {
    try {
      try {
        process.kill(entry.pid, 0)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          return "gone"
        throw error
      }
      if (
        !(await processIdentityMatches({
          pid: entry.pid,
          startedAt: entry.processStartedAt ?? entry.startedAt,
          signal,
          exact: entry.processStartedAt !== undefined,
          toleranceMs: entry.processStartedAt === undefined ? 1_500 : undefined,
        }))
      )
        return "gone"
      const matches = await processExecutableMatches({
        pid: entry.pid,
        executable:
          entry.executableIdentity ??
          (await legacyShebangExecutable(entry.executable)) ??
          entry.executable,
        signal,
      })
      return matches ? "owned" : "unavailable"
    } catch {
      // Permission failures, wrapper exec transitions and unavailable OS
      // reads are not evidence of death. Preserve the exact record for a
      // later verified observation instead of silently dropping its owner.
      return "unavailable"
    }
  }
}

function childRecordId(entry: ProviderChildRecord): string {
  return `${entry.host}:${entry.pid}:${entry.startedAt}`
}

function hostIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
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

type ProviderChildEvent =
  | { spawned: { pid: number; executable: string; kind: string; owner: string; session?: string | null } }
  | { owned: { pid: number; owner: string } }
  | { bound: { pid: number; session: string | null } }
  | { exited: number }

/** Spawns and exits, published by whoever starts a provider process and kept by the host's registry. */
const events = topic<ProviderChildEvent>("mako:provider-child")

/** Report a spawned provider process until it exits. */
export function trackProviderChild(
  child: ChildProcess,
  info: { kind: string; owner: string }
): void {
  const pid = child.pid
  if (!pid || !events.heard) return
  events.publish({ spawned: { pid, executable: child.spawnfile, ...info } })
  child.once("exit", () => events.publish({ exited: pid }))
}

/** For a spawner that reports the exit from its own exit handler, with `untrackProviderPid`. */
export function trackProviderPid(info: { pid: number; executable: string; kind: string; owner: string; session?: string | null }): void {
  events.publish({ spawned: info })
}

/** The native session a recorded process holds from now on (`ProviderChildRecord.session`). */
export function bindProviderPid(pid: number, session: string | null): void {
  events.publish({ bound: { pid, session } })
}

/** For a process another owner takes over, keeping the birth its record was made with. */
export function reownProviderPid(pid: number, owner: string): void {
  events.publish({ owned: { pid, owner } })
}

export function untrackProviderPid(pid: number): void {
  events.publish({ exited: pid })
}

/** A harness process a Mako host on this Mac recorded, with the session it says it holds. */
export interface MakoProcess {
  /** The native session it holds, or null for none of a harness's existing sessions. */
  session: string | null
  /** When it started: its observed start, or the host's clock as it spawned it. */
  startedAt: number
  /** Whether `startedAt` is the observed start, to be matched exactly, rather than the spawn's clock. */
  observed: boolean
  /** Which host started it, for what a refusal says. */
  host: number
}

/**
 * Every harness process the Mako hosts with data roots `roots` recorded and say what they hold (`session` set),
 * by pid, from each root's `runtime/provider-children.json`. A record whose host is gone is left out; one that names
 * no session (an older build's) isn't known and is left out too, so it stays unaccounted for. Reading says nothing of
 * whether the pid still runs the recorded process: whoever relies on a record checks its start (`startedAt`).
 */
export function readMakoProcesses(roots: Iterable<string>): Map<number, MakoProcess> {
  const processes = new Map<number, MakoProcess>()
  for (const root of new Set(roots)) {
    let children: ProviderChildRecord[]
    try {
      children = RegistrySchema.parse(JSON.parse(readFileSync(join(root, "runtime", "provider-children.json"), "utf8"))).children
    } catch {
      continue
    }
    for (const entry of children) {
      if (entry.session === undefined || hostIsGone(entry.host)) continue
      processes.set(entry.pid, {
        session: entry.session,
        startedAt: entry.processStartedAt ?? entry.startedAt,
        observed: entry.processStartedAt !== undefined,
        host: entry.host,
      })
    }
  }
  return processes
}
