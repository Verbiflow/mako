import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { ProviderStartupWatch, type StartupWatchOptions } from "../../../provider-startup.js"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { LineAssembler } from "@mako/sessions"
import { hostLog, hostLogPath, hostWarn } from "../../../host-log.js"
import { spawnProviderProcess } from "../../provider-process.js"
import { headlessNodeExecutable } from "../../../headless-node.js"
import {
  CURSOR_SDK_MAX_LINE_BYTES,
  CURSOR_SDK_WIRE_VERSION,
  JsonValueSchema,
  SdkChildLineSchema,
  SdkResultSchemas,
  type JsonValue,
  type SdkEvent,
  type SdkMethod,
  type SdkRequest,
  type SdkResult,
  type SdkWireError,
} from "./wire.js"
import { z } from "zod"

/** Which line a refused one was, read without its content. */
const LineEnvelopeSchema = z.object({
  event: z.string().optional(),
  message: z.object({ type: z.string() }).optional(),
})

/** Where the wire refused a line: a field path, never its value. */
function refusedField(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue ? `${issue.path.join(".") || "line"}: ${issue.code}` : "line"
}

/** A failure the child reported, carrying the SDK's own classification. */
export class CursorSdkError extends Error {
  readonly kind: SdkWireError["kind"]
  readonly code: string | undefined
  readonly networkCauses: SdkWireError["networkCauses"]
  readonly retryable: boolean
  constructor(error: SdkWireError) {
    super(error.message)
    this.name = "CursorSdkError"
    this.kind = error.kind
    this.networkCauses = error.networkCauses
    this.code = error.code
    this.retryable = error.retryable ?? false
  }
}

/** The child went away before answering; the request's effect is unknown. */
export class CursorSdkDisconnectedError extends Error {
  constructor(message = "The Cursor SDK process closed before answering") {
    super(message)
    this.name = "CursorSdkDisconnectedError"
  }
}

export interface CursorSdkClientOptions {
  /** The conversation the child serves; recorded so a later host can reap it. */
  owner: string
  cwd: string
  env: NodeJS.ProcessEnv
  onEvent(event: SdkEvent): void
  /** Test hook: another entry file or executable than the host's own. */
  entry?: string
  execPath?: string
  requestTimeoutMs?: number
  /** Test hook for the shared startup policy; runtime requests keep their own deadline. */
  startupTimeouts?: Pick<StartupWatchOptions, "silenceMs" | "totalMs">
}

interface Pending {
  method: SdkMethod
  resolve(value: JsonValue | undefined): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | undefined
}

function parseJsonLine(line: string): JsonValue | undefined {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

type Params<Method extends SdkMethod> = Extract<SdkRequest, { method: Method }> extends { params: infer P } ? P : undefined

/**
 * Requests that legitimately outlast the ordinary deadline: a browser
 * sign-in; a steer, whose acknowledgement the run holds until the agent
 * takes the text or the turn ends; and a send, which the SDK may answer long
 * after starting the run on a loaded machine. A deadline there turned a
 * running turn into a "failed" one whose output the host then discarded.
 * The child answers each of them or exits, and its exit rejects them.
 */
const UNBOUNDED: ReadonlySet<SdkMethod> = new Set<SdkMethod>(["login", "steer", "send"])
const STARTUP_METHODS: ReadonlySet<SdkMethod> = new Set<SdkMethod>(["hello", "authStatus", "models", "open"])

/**
 * A child per conversation stays warm between turns, so its young generation
 * is held small: with V8's default it kept about 25MB more while idle, and
 * 12–15MB more after a turn, on Cursor SDK 1.0.31 (2026-10-05).
 */
const CHILD_V8_FLAGS = ["--max-semi-space-size=1"]

/**
 * `kill -USR2 <pid>` writes a heap snapshot of a child beside the host log,
 * for a session whose SDK holds more than it should. Free until signalled.
 */
function heapSnapshotFlags(): string[] {
  const log = hostLogPath()
  if (!log) return []
  const directory = join(dirname(log), "cursor-heaps")
  mkdirSync(directory, { recursive: true })
  return ["--heapsnapshot-signal=SIGUSR2", `--diagnostic-dir=${directory}`]
}

/**
 * What V8 writes on stderr before aborting, most specific first. Only which
 * marker appeared is kept: the rest of stderr may contain provider input.
 */
const RUNTIME_FATALS = [
  { marker: "JavaScript heap out of memory", reason: "it ran out of JavaScript heap" },
  { marker: "FATAL ERROR:", reason: "its JavaScript runtime aborted" },
] as const
const FATAL_MARKER_OVERLAP = Math.max(...RUNTIME_FATALS.map(({ marker }) => marker.length)) - 1
const STDERR_DRAIN_MS = 250

export type CursorSdkExit = {
  code: number | null
  signal: NodeJS.Signals | null
  fatal: (typeof RUNTIME_FATALS)[number]["reason"] | undefined
}

export function cursorSdkChildEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "child.js")
}

/**
 * The host's end of the SDK child: spawns it from the host executable under
 * `ELECTRON_RUN_AS_NODE`, sends requests, matches responses by id, and hands
 * events to the owner. A malformed line is dropped and reported, never allowed
 * to end the session; a child that exits fails every pending request with a
 * disconnect, which callers treat as "unknown", not "not done".
 */
export class CursorSdkClient {
  readonly exited: Promise<CursorSdkExit>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private readonly lines = new LineAssembler(CURSOR_SDK_MAX_LINE_BYTES)
  private readonly options: CursorSdkClientOptions
  private nextId = 1
  private closed = false

  constructor(options: CursorSdkClientOptions) {
    this.options = options
    const env: NodeJS.ProcessEnv = { ...options.env, ELECTRON_RUN_AS_NODE: "1" }
    delete env.NODE_OPTIONS
    this.child = spawnProviderProcess(headlessNodeExecutable(options.execPath), [...CHILD_V8_FLAGS, ...heapSnapshotFlags(), options.entry ?? cursorSdkChildEntry()], {
      cwd: options.cwd,
      env,
      windowsHide: true,
    }, { kind: "cursor:sdk", owner: options.owner })
    const fatals = new Set<string>()
    let stderrTail = ""
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrTail + chunk.toString("latin1")
      for (const { marker } of RUNTIME_FATALS) if (text.includes(marker)) fatals.add(marker)
      stderrTail = text.slice(-FATAL_MARKER_OVERLAP)
    })
    const stderrEnded = new Promise<void>((resolve) => this.child.stderr.once("close", resolve))
    this.child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk))
    this.exited = new Promise((resolve) => {
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        this.closed = true
        this.failPending(new CursorSdkDisconnectedError())
        const drained = new Promise<void>((done) => setTimeout(done, STDERR_DRAIN_MS).unref())
        void Promise.race([stderrEnded, drained]).then(() =>
          resolve({ code, signal, fatal: RUNTIME_FATALS.find(({ marker }) => fatals.has(marker))?.reason }))
      }
      this.child.once("exit", settle)
      this.child.once("error", (error) => {
        hostWarn("cursor-sdk", "child process error", { owner: options.owner, error: error.message })
        settle(null, null)
      })
    })
  }

  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** Confirms the child speaks this wire version before anything else is sent. */
  async hello(): Promise<SdkResult<"hello">> {
    const hello = await this.request("hello", undefined)
    if (hello.wire !== CURSOR_SDK_WIRE_VERSION)
      throw new CursorSdkError({
        kind: "configuration",
        message: `The Cursor SDK child speaks wire ${hello.wire}; this host expects ${CURSOR_SDK_WIRE_VERSION}`,
      })
    return hello
  }

  request<Method extends SdkMethod>(method: Method, params: Params<Method>): Promise<SdkResult<Method>> {
    if (!STARTUP_METHODS.has(method)) return this.sendRequest(method, params, true)
    const watch = new ProviderStartupWatch(this.child, {
      harness: "Cursor", ...this.options.startupTimeouts,
    })
    return watch.step(method, this.sendRequest(method, params, false))
      .catch((error: Error) => {
        // An SDK method can return a normal typed refusal (e.g. signed out).
        // Preserve that usable client; a lost/uncertain startup must be closed.
        if (!(error instanceof CursorSdkError)) this.kill()
        throw error
      })
      .finally(() => {
        hostLog("cursor-sdk", "startup step", { owner: this.options.owner, steps: watch.summary() })
        watch.dispose()
      })
  }

  private sendRequest<Method extends SdkMethod>(method: Method, params: Params<Method>, bounded: boolean): Promise<SdkResult<Method>> {
    if (!this.alive) return Promise.reject(new CursorSdkDisconnectedError())
    const id = this.nextId++
    // SAFETY: `Params<Method>` is `undefined` exactly for the methods whose request carries no `params`, and otherwise the `params` type of the request whose `method` is `Method`.
    const line: SdkRequest = params === undefined ? ({ id, method } as SdkRequest) : ({ id, method, params } as SdkRequest)
    const schema = SdkResultSchemas[method]
    return new Promise<SdkResult<Method>>((resolve, reject) => {
      const requestedTimeout = this.options.requestTimeoutMs ?? 60_000
      // Stop must reach its process-close fallback promptly when the SDK is
      // wedged; ordinary sends retain their longer request deadline.
      const timeout = method === "cancel" || method === "me" ? Math.min(requestedTimeout, 5_000) : requestedTimeout
      const timer = !bounded || UNBOUNDED.has(method)
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id)
            reject(new CursorSdkDisconnectedError(`The Cursor SDK did not answer ${method} within ${Math.round(timeout / 1000)}s`))
          }, timeout)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          const parsed = schema.safeParse(value)
          if (parsed.success) {
            // SAFETY: `schema` is `SdkResultSchemas[Method]`, so its output is `SdkResult<Method>`.
            resolve(parsed.data as SdkResult<Method>)
          } else
            reject(new CursorSdkError({ kind: "configuration", message: `The Cursor SDK answered ${method} with a shape this host does not read` }))
        },
        reject,
        timer,
      })
      this.child.stdin?.write(`${JSON.stringify(line)}\n`, (error) => {
        if (!error) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(new CursorSdkDisconnectedError(error.message))
      })
    })
  }

  /** Asks the child to close its agent and waits for it; kills it when it lingers. */
  async close(graceMs = 5_000): Promise<void> {
    if (!this.alive) {
      await this.exited
      return
    }
    const timer = setTimeout(() => this.child.kill("SIGKILL"), graceMs)
    try {
      await this.request("close", undefined).catch(() => undefined)
      await this.exited
    } finally {
      clearTimeout(timer)
    }
  }

  /** Ends the process without a goodbye; for a session that is already lost. */
  kill(): void {
    this.child.kill("SIGKILL")
  }

  private receive(chunk: Buffer): void {
    const lines = this.lines.push(chunk)
    if (lines === null) {
      hostWarn("cursor-sdk", "child line exceeded the wire limit; closing", { owner: this.options.owner })
      this.kill()
      return
    }
    for (const line of lines) {
      if (!line.trim()) continue
      const raw = parseJsonLine(line)
      if (raw === undefined) {
        hostWarn("cursor-sdk", "dropped a child line that was not JSON", { owner: this.options.owner })
        continue
      }
      const parsed = SdkChildLineSchema.safeParse(raw)
      if (!parsed.success) {
        const envelope = LineEnvelopeSchema.safeParse(raw)
        hostWarn("cursor-sdk", "dropped a child line the wire does not describe", {
          owner: this.options.owner,
          line: envelope.success ? [envelope.data.event, envelope.data.message?.type].filter(Boolean).join("/") || "response" : "unknown",
          field: refusedField(parsed.error),
        })
        continue
      }
      const message = parsed.data
      if ("event" in message) {
        if (message.event === "log") {
          hostWarn("cursor-sdk", message.message, { owner: this.options.owner, level: message.level })
          continue
        }
        this.options.onEvent(message)
        continue
      }
      const entry = this.pending.get(message.id)
      if (!entry) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.result)
      else {
        if (message.error.kind === "network") hostWarn("cursor-sdk", "native network request failed", {
          owner: this.options.owner, method: entry.method,
          networkCauses: message.error.networkCauses?.join(",") ?? "unavailable",
        })
        entry.reject(new CursorSdkError(message.error))
      }
    }
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
