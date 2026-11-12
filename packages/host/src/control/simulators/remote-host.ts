import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  LOCAL_HOST,
  type ListedSimulator,
  type SimulatorArtifact,
  type SimulatorCaller,
  type SimulatorHostSummary,
  type SimulatorRefused,
  type SimulatorsActInput,
  type SimulatorsActResult,
  type SimulatorsListed,
  type SimulatorsOpenInput,
  type SimulatorsOpenResult,
  type SimulatorsReadInput,
  type SimulatorsReadResult,
  type SimulatorsRecordInput,
  type SimulatorsRecordResult,
  type SimulatorsReleaseInput,
  type SimulatorsReleaseResult,
  type SimulatorsShotInput,
  type SimulatorsShotResult,
  type SimulatorsWatchInput,
  type SimulatorsWatchResult,
} from "../../contracts/simulators.js"
import { OwnerUnavailableError, RuntimeDisconnectedError } from "../../contracts/host-connection.js"
import { hostWarn } from "../../base/host-log.js"
import type { RemoteSimulatorHost } from "./host.js"

/**
 * One host call to the other Mac, its value already decoded; the caller names the verb's result when it reads it.
 * Throws as `gatewayHostCalls` does when the Mac isn't there.
 */
export type SimulatorHostCall = (channel: `mako:simulators-${string}`, args: readonly unknown[]) => Promise<object>

/** How long a list waits for another Mac before saying it didn't answer: one slow Mac never holds up the panel. */
export const REMOTE_LIST_MS = 3_000
/** How long any other call waits: a boot and a page load on the other Mac fit, a Mac gone quiet doesn't. */
export const REMOTE_CALL_MS = 60_000

/**
 * Another of the person's Macs, as this Mac reaches its simulators: through its runtime link (`d-<device>`), by the
 * same `mako:simulators-<verb>` calls this Mac's own panel makes. That Mac decides who drives each simulator, checks
 * that it offers them at all, and stamps where each call came from; this Mac only names its hosts `mac:<device>`, so
 * every caller here names a simulator by its host and its ID, and keeps its screenshots on this Mac.
 */
export class RemoteMacSimulators implements RemoteSimulatorHost {
  readonly id: string
  readonly label: string
  readonly #call: SimulatorHostCall
  readonly #shots: string
  readonly #listMs: number
  readonly #callMs: number
  readonly #artifact: ((artifact: SimulatorArtifact) => Promise<string>) | undefined

  /** `artifact`: a file that Mac gave this caller's session lease (a large picture, a recording), fetched here; its path. */
  constructor(options: { id: string; label: string; call: SimulatorHostCall; shots: string; listMs?: number; callMs?: number; artifact?: (artifact: SimulatorArtifact) => Promise<string> }) {
    this.id = options.id
    this.label = options.label
    this.#call = options.call
    this.#shots = options.shots
    this.#listMs = options.listMs ?? REMOTE_LIST_MS
    this.#callMs = options.callMs ?? REMOTE_CALL_MS
    this.#artifact = options.artifact
  }

  async list(caller: SimulatorCaller): Promise<{ hosts: SimulatorHostSummary[]; simulators: ListedSimulator[] }> {
    let listed: SimulatorsListed
    try {
      listed = await this.#send<SimulatorsListed>("list", [outgoing(caller)], this.#listMs)
    } catch (error) {
      const why = whyUnreachable(this.id, this.label, error instanceof Error ? error : new Error(String(error)))
      const blocked = { ready: false as const, blocker: "unreachable" as const, why }
      return { hosts: [{ id: this.id, label: this.label, kind: "mac", platforms: { ios: blocked, android: blocked } }], simulators: [] }
    }
    // That Mac's own simulators only: what it reaches of other Macs, this Mac reaches itself.
    const own = listed.hosts.filter((host) => host.id === LOCAL_HOST)
    return {
      hosts: own.map((host) => ({ ...host, id: this.id, label: this.label, kind: "mac" })),
      simulators: listed.simulators.filter((simulator) => simulator.hostId === LOCAL_HOST).map((simulator) => ({ ...simulator, hostId: this.id })),
    }
  }

  async open(caller: SimulatorCaller, input: SimulatorsOpenInput): Promise<SimulatorsOpenResult> {
    const opened = await this.#verb<SimulatorsOpenResult>("open", caller, input)
    return "refused" in opened ? opened : { ...opened, simulator: { ...opened.simulator, hostId: this.id } }
  }

  act(caller: SimulatorCaller, input: SimulatorsActInput): Promise<SimulatorsActResult> {
    return this.#verb("act", caller, input)
  }

  read(caller: SimulatorCaller, input: SimulatorsReadInput): Promise<SimulatorsReadResult> {
    return this.#verb("read", caller, input)
  }

  /** That Mac's picture, kept here: its path there means nothing to a caller on this Mac. */
  async shot(caller: SimulatorCaller, input: SimulatorsShotInput): Promise<SimulatorsShotResult> {
    const asked: SimulatorsShotInput = { ...input, inline: true }
    const shot = await this.#verb<SimulatorsShotResult>("shot", caller, asked)
    if ("refused" in shot) return shot
    if (!shot.inline && shot.artifact && this.#artifact) return { path: await this.#artifact(shot.artifact), width: shot.width, height: shot.height }
    if (!shot.inline) return { refused: "unsupported", why: `${this.label}'s picture is too large to send here; watch the simulator instead.` }
    await mkdir(this.#shots, { recursive: true })
    const path = join(this.#shots, `${randomUUID()}.${shot.inline.type === "image/jpeg" ? "jpg" : "png"}`)
    await writeFile(path, Buffer.from(shot.inline.data, "base64"))
    return { path, width: shot.width, height: shot.height }
  }

  /** A stopped recording that Mac gave this caller's lease comes here as a file; without a lease it stays there. */
  async record(caller: SimulatorCaller, input: SimulatorsRecordInput): Promise<SimulatorsRecordResult> {
    const recorded = await this.#verb<SimulatorsRecordResult>("record", caller, input)
    if ("refused" in recorded || !recorded.artifact || !this.#artifact) return recorded
    return { path: await this.#artifact(recorded.artifact) }
  }

  release(caller: SimulatorCaller, input: SimulatorsReleaseInput): Promise<SimulatorsReleaseResult> {
    return this.#verb("release", caller, input)
  }

  watch(caller: SimulatorCaller, input: SimulatorsWatchInput): Promise<SimulatorsWatchResult> {
    return this.#verb("watch", caller, input)
  }

  /** A verb on one of that Mac's simulators, which it names as its own; a Mac that isn't there is refused as `unreachable`. */
  async #verb<Result extends object, Input extends { host?: string } = { host?: string }>(verb: string, caller: SimulatorCaller, input: Input): Promise<Result | SimulatorRefused> {
    try {
      return await this.#send<Result>(verb, [outgoing(caller), { ...input, host: LOCAL_HOST }], this.#callMs)
    } catch (error) {
      return { refused: "unreachable", why: whyUnreachable(this.id, this.label, error instanceof Error ? error : new Error(String(error))) }
    }
  }

  async #send<Result extends object>(verb: string, args: readonly unknown[], ms: number): Promise<Result> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RemoteTimeout(ms)), ms)
    })
    try {
      const value = await Promise.race([this.#call(`mako:simulators-${verb}`, args), late])
      // SAFETY: the channel is a simulators verb whose decoded host reply is Result; the gateway already parsed it.
      return value as Result
    } finally {
      clearTimeout(timer)
    }
  }
}

class RemoteTimeout extends Error {
  readonly ms: number
  constructor(ms: number) {
    super(`No answer within ${ms} ms`)
    this.ms = ms
  }
}

/** Why that Mac didn't answer, in words a caller can act on; a failure that isn't the link's is logged. */
function whyUnreachable(host: string, label: string, error: Error): string {
  if (error instanceof RemoteTimeout) return `${label} didn't answer within ${Math.round(error.ms / 1000)} s.`
  if (error instanceof OwnerUnavailableError) return `${label} isn't connected now. Its simulators are offered again once it's awake and online.`
  if (error instanceof RuntimeDisconnectedError) return `${label} couldn't be reached through Mako's cloud just now.`
  const why = `${label} answered with an error: ${error.message}`
  hostWarn("simulators", "another Mac's call failed", { host, error: why })
  return why
}

/**
 * The caller as it goes to the other Mac: its `via` is that Mac's to stamp, never this one's to say. An agent that
 * already carries its Thread (`agent`) keeps it: that Session isn't on the other Mac.
 */
function outgoing(caller: SimulatorCaller): SimulatorCaller {
  return caller.kind === "agent"
    ? { kind: "agent", session: caller.session, ...(caller.agent && { agent: caller.agent }) }
    : { kind: "person" }
}
