import { hostFetch } from "../../base/host-stopping.js"
import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { ScreenConfigSchema, type ScreenConfig } from "./hid.js"
import type { Run } from "./setup.js"
import type { CaptureSource } from "./capture.js"
import { ToolProcess } from "./tool-process.js"

/** The header the hub reads its token from (`electron/simulator-hub.ts`). */
export const HUB_TOKEN_HEADER = "x-mako-hub"
/** The longest path macOS binds a Unix socket at: `sun_path` is 104 bytes with its terminating zero. */
const SOCKET_PATH_BYTES = 103

/**
 * Where inspect-webkit's server listens: in the hub's own folder, or, when that path is too long to bind, in this
 * user's own temporary folder under a name made from the hub's folder, so two hosts never share one.
 */
export function inspectorSocket(folder: string, temporary = tmpdir()): string {
  const inFolder = join(folder, "inspector.sock")
  if (Buffer.byteLength(inFolder) <= SOCKET_PATH_BYTES) return inFolder
  return join(temporary, `mako-hub-${createHash("sha256").update(folder).digest("hex").slice(0, 16)}.sock`)
}

/** Where the hub is and what it takes: every request to it carries these headers. */
export interface HubConnection {
  origin: string
  headers: Record<string, string>
}

export interface SimulatorHubOptions {
  /** `electron/simulator-hub-entry`, built or as source. */
  entry: string
  /** Node's flags for it: none for the built file, `--import tsx` for its source. */
  execArgv?: string[]
  /** The installed serve-sim and inspect-webkit packages. */
  serveSim: string
  inspectWebkit: string
  /** The host's own folder for the hub: its record, inspect-webkit's socket file and serve-sim's state. */
  folder: string
  run: Run
  env?: NodeJS.ProcessEnv
}

const AxElementSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  role: z.string().optional(),
  type: z.string().optional(),
  enabled: z.boolean().optional(),
  frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
})
export const AxSnapshotSchema = z.object({ screen: z.object({ width: z.number(), height: z.number() }).optional(), elements: z.array(AxElementSchema) })
export type AxSnapshot = z.infer<typeof AxSnapshotSchema>
export type AxElement = z.infer<typeof AxElementSchema>

export const InspectorTargetSchema = z.object({
  id: z.string(),
  pid: z.number(),
  app: z.string().optional(),
  bundleId: z.string().optional(),
  title: z.string(),
  url: z.string(),
  type: z.string(),
  inUse: z.boolean(),
})
export type InspectorTarget = z.infer<typeof InspectorTargetSchema>

/**
 * The host's simulator hub: started on first use on a loopback port with a token made for this run, restarted when
 * it exits, and stopped with the host. It's the one process that holds a simulator's capture, touch and web inspector.
 */
export class SimulatorHub implements CaptureSource {
  readonly #token = randomBytes(32).toString("base64url")
  readonly #process: ToolProcess
  readonly #folder: string
  #prepared: Promise<void> | undefined
  /** Moved on by stop, so a connection already waiting to start then doesn't. */
  #generation = 0

  constructor(options: SimulatorHubOptions) {
    this.#folder = options.folder
    const socket = inspectorSocket(options.folder)
    this.#process = new ToolProcess({
      name: "simulator-hub",
      entry: options.entry,
      execArgv: options.execArgv,
      args: (port) => ["--port", String(port), "--serve-sim", options.serveSim, "--inspect-webkit", options.inspectWebkit, "--socket", socket],
      // serve-sim keeps its state under TMPDIR: the hub's own folder, not the one the person's own serve-sim uses.
      env: { ...(options.env ?? process.env), MAKO_SIMULATOR_HUB_TOKEN: this.#token, TMPDIR: join(options.folder, "tmp") },
      ready: async (origin) => (await hostFetch(`${origin}/health`, { headers: this.#headers(), signal: AbortSignal.timeout(2_000) })).ok,
      stateFile: join(options.folder, "hub.json"),
      run: options.run,
    })
  }

  get running(): boolean {
    return this.#process.running
  }

  async connection(): Promise<HubConnection> {
    const generation = this.#generation
    await (this.#prepared ??= mkdir(join(this.#folder, "tmp"), { recursive: true }).then(() => chmod(this.#folder, 0o700)))
    // Stop can land in that await, before the process is spawned: starting afterwards would undo the stop.
    if (generation !== this.#generation) throw new Error("simulator-hub was stopped while it started")
    return { origin: await this.#process.origin(), headers: this.#headers() }
  }

  #headers(): HubConnection["headers"] {
    return { [HUB_TOKEN_HEADER]: this.#token }
  }

  async #get(path: string, timeoutMs = 10_000): Promise<Response> {
    const { origin, headers } = await this.connection()
    const response = await hostFetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`The simulator hub answered ${path.split("/").pop()} with ${response.status}: ${(await response.text()).slice(0, 200)}`)
    return response
  }

  /** The screen as the capture has it: pixels, and its orientation. */
  async config(udid: string): Promise<ScreenConfig | undefined> {
    const response = await this.#get(`/helper/${udid}/config`)
    return ScreenConfigSchema.safeParse(await response.json()).data
  }

  async size(udid: string): Promise<{ width: number; height: number } | undefined> {
    const config = await this.config(udid).catch(() => undefined)
    return config && config.width > 0 && config.height > 0 ? { width: config.width, height: config.height } : undefined
  }

  /** The screen's accessibility elements, in points. */
  async accessibility(udid: string): Promise<AxSnapshot> {
    const response = await this.#get(`/helper/${udid}/ax`, 15_000)
    return AxSnapshotSchema.parse(await response.json())
  }

  async open(udid: string, route: "stream.avcc" | "stream.mjpeg", signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const { origin, headers } = await this.connection()
    const response = await hostFetch(`${origin}/helper/${udid}/${route}`, { headers, signal })
    if (!response.ok || !response.body) throw new Error(`The simulator hub answered ${route} with ${response.status}`)
    return response.body
  }

  /** Web inspector targets on every running simulator, each with the PID of the simulator's `launchd_sim`. */
  async targets(): Promise<InspectorTarget[]> {
    const response = await this.#get("/inspector/targets", 20_000)
    return z.array(InspectorTargetSchema).parse(await response.json())
  }

  stop(): Promise<void> {
    this.#generation++
    return this.#process.stop()
  }
}
