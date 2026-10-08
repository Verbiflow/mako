import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import {
  MAX_BATCH_EVENTS,
  type DiagnosticEvents,
  type ProductEvents,
  type TelemetryApp,
  type TelemetryBatch,
  type TelemetryChoice,
  type TelemetryEvent,
  type TelemetryName,
  type TelemetryOff,
  type TelemetryProps,
  type TelemetryState,
} from "./contracts/telemetry.js"
import type { HostLogFields } from "./host-log.js"

/**
 * Usage analytics and error reports, batched to the Mako cloud's
 * `/v1/telemetry`. The cloud forwards what the person allows and nothing
 * else; see `contracts/telemetry.ts` for what each kind holds.
 *
 * Cheap by construction: recording an event is an array push. Nothing wakes
 * while the queue is empty; a batch goes out `FLUSH_MS` after the first event
 * queued, or at once at `FLUSH_AT` events, and on quit. The queue is bounded,
 * oldest dropped first. With both kinds off, or no cloud to send to, nothing
 * is queued and no request is ever made.
 */
const FLUSH_MS = 30_000
const FLUSH_AT = 50
const MAX_QUEUE = 1_000
/** Under the gateway's 256 KB limit, with room for the batch's own fields. */
const MAX_BATCH_BYTES = 200 * 1024
const REQUEST_MS = 10_000
const RETRY_MS = { first: 30_000, max: 30 * 60_000 }
const DAY_MS = 86_400_000

type Stream = keyof TelemetryChoice

interface Queued extends TelemetryEvent {
  stream: Stream
}

const StoredSchema = z.object({
  install: z.uuid(),
  usage: z.boolean(),
  errors: z.boolean(),
  /** When the last heartbeat went, so a host that restarts often still sends one a day. */
  heartbeatAt: z.number().optional(),
  /** The newest crash report already reported; the crash folder is read past it. */
  crashesThrough: z.string().optional(),
})
type Stored = z.infer<typeof StoredSchema>

export interface TelemetryOptions {
  /** This install's ID and the person's choice, in its data folder; without one they last until quit. */
  file?: string
  /** The cloud's origin; telemetry is off without one. */
  cloud: string | undefined
  app: TelemetryApp
  /** Off whatever the person chose, and why. */
  off?: Exclude<TelemetryOff, "no-cloud">
  /** A connection token while this Mac is signed in to Mako, so its events count for the account. */
  token?: () => Promise<string | undefined>
  fetch?: typeof fetch
  now?: () => number
  log?: (message: string, fields?: HostLogFields) => void
}

/** `DO_NOT_TRACK=1` or `MAKO_TELEMETRY=off` turn it off; `MAKO_TELEMETRY=on` turns it on for a fixture desk. */
export function telemetryOff(env: NodeJS.ProcessEnv, fixture: boolean): Exclude<TelemetryOff, "no-cloud"> | undefined {
  const setting = env.MAKO_TELEMETRY?.toLowerCase()
  if (setting === "off" || setting === "0" || setting === "false") return "environment"
  if (env.DO_NOT_TRACK === "1" || env.DO_NOT_TRACK?.toLowerCase() === "true") return "environment"
  if (fixture && setting !== "on") return "fixture"
  return undefined
}

export class Telemetry {
  readonly firstRun: boolean
  #options: TelemetryOptions
  #stored: Stored
  #endpoint: URL | undefined
  #queue: Queued[] = []
  #timer: NodeJS.Timeout | undefined
  #sending: Promise<void> | undefined
  #pausedUntil = 0
  #retryMs = RETRY_MS.first
  #failing = false
  #closed = false

  private constructor(options: TelemetryOptions, stored: Stored, firstRun: boolean) {
    this.#options = options
    this.#stored = stored
    this.firstRun = firstRun
    this.#endpoint = endpointOf(options.cloud)
  }

  /** Reads this install's ID and choice, making both the first time; never throws. */
  static async open(options: TelemetryOptions): Promise<Telemetry> {
    const existing = options.file === undefined ? undefined : await readFile(options.file, "utf8").then(
      (text) => StoredSchema.safeParse(JSON.parse(text)).data,
      () => undefined
    )
    const telemetry = new Telemetry(options, existing ?? { install: randomUUID(), usage: true, errors: true }, !existing)
    if (!existing) await telemetry.#save()
    return telemetry
  }

  get install(): string {
    return this.#stored.install
  }

  state(): TelemetryState {
    const off = this.#options.off ?? (this.#endpoint ? undefined : "no-cloud")
    return { usage: this.#stored.usage, errors: this.#stored.errors, ...(off && { off }) }
  }

  /** Whether `stream` is collected right now: allowed, and somewhere to send it. */
  collects(stream: Stream): boolean {
    return !this.#closed && !this.#options.off && this.#endpoint !== undefined && this.#stored[stream]
  }

  /** Saves the person's choice. Whatever they turned off and hadn't been sent yet is dropped here. */
  async choose(choice: Partial<TelemetryChoice>): Promise<TelemetryState> {
    this.#stored = { ...this.#stored, ...choice }
    this.#queue = this.#queue.filter((event) => this.#stored[event.stream])
    if (!this.#queue.length) this.#cancelTimer()
    await this.#save()
    return this.state()
  }

  record<Name extends keyof ProductEvents>(name: Name, props: ProductEvents[Name]): void {
    this.#enqueue("usage", name, props)
  }

  report<Name extends keyof DiagnosticEvents>(name: Name, props: DiagnosticEvents[Name]): void {
    this.#enqueue("errors", name, SCRUB_PROPS[name](props))
  }

  /** True once a day; the stamp is kept, so restarting the host doesn't send another. */
  async heartbeatDue(): Promise<boolean> {
    if (!this.collects("usage")) return false
    const now = this.#now()
    if (this.#stored.heartbeatAt !== undefined && now - this.#stored.heartbeatAt < DAY_MS && this.#stored.heartbeatAt <= now) return false
    this.#stored = { ...this.#stored, heartbeatAt: now }
    await this.#save()
    return true
  }

  /** The newest crash already reported; undefined the first time, which reports none from before. */
  crashesThrough(): string | undefined {
    return this.#stored.crashesThrough
  }

  async reportedCrashesThrough(id: string): Promise<void> {
    if (this.#stored.crashesThrough !== undefined && this.#stored.crashesThrough >= id) return
    this.#stored = { ...this.#stored, crashesThrough: id }
    await this.#save()
  }

  /** Sends everything queued, a batch at a time; resolves when done or when the cloud says wait. */
  flush(): Promise<void> {
    this.#cancelTimer()
    this.#sending ??= this.#drain().finally(() => {
      this.#sending = undefined
      if (this.#queue.length) this.#schedule()
    })
    return this.#sending
  }

  /** The last flush, given at most `waitMs`; nothing is queued after it. */
  async close(waitMs = 2_000): Promise<void> {
    if (this.#closed) return
    const last = this.flush()
    this.#closed = true
    let timer: NodeJS.Timeout | undefined
    await Promise.race([last, new Promise((done) => (timer = setTimeout(done, waitMs)))])
    clearTimeout(timer)
    this.#cancelTimer()
  }

  #enqueue(stream: Stream, name: TelemetryName, props: TelemetryProps): void {
    if (!this.collects(stream)) return
    this.#queue.push({ stream, id: randomUUID(), at: this.#now(), name, props })
    if (this.#queue.length > MAX_QUEUE) this.#queue.splice(0, this.#queue.length - MAX_QUEUE)
    if (this.#queue.length >= FLUSH_AT && this.#pausedUntil <= this.#now()) void this.flush()
    else this.#schedule()
  }

  async #drain(): Promise<void> {
    while (this.#queue.length && this.#endpoint && this.#pausedUntil <= this.#now()) {
      const batch = this.#nextBatch()
      const sent = await this.#send(batch).catch((error) => {
        this.#failed({ error: error instanceof Error ? error.name : "unknown" })
        return "retry" as const
      })
      if (sent === "retry") return
      const ids = new Set(batch.map((event) => event.id))
      this.#queue = this.#queue.filter((event) => !ids.has(event.id))
      if (sent === "paused") return
    }
  }

  #nextBatch(): Queued[] {
    const batch: Queued[] = []
    let bytes = 0
    for (const event of this.#queue) {
      if (!this.#stored[event.stream]) continue
      const size = JSON.stringify(event).length
      if (batch.length && (batch.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES)) break
      batch.push(event)
      bytes += size
    }
    return batch
  }

  /** `sent` and `paused` take the batch off the queue; `retry` leaves it for later. */
  async #send(events: Queued[]): Promise<"sent" | "paused" | "retry"> {
    const endpoint = this.#endpoint
    if (!endpoint || !events.length) return "sent"
    const batch: TelemetryBatch = {
      install: this.#stored.install,
      sentAt: this.#now(),
      app: this.#options.app,
      consent: { product: this.#stored.usage, diagnostics: this.#stored.errors },
      events: events.map(({ id, at, name, props }) => ({ id, at, name, props })),
    }
    const token = await this.#options.token?.().catch(() => undefined)
    const response = await (this.#options.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(batch),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
    })
    if (response.status === 429 || response.status >= 500) {
      const wait = Number(response.headers.get("retry-after"))
      this.#failed({ status: response.status }, Number.isFinite(wait) && wait > 0 ? wait * 1000 : undefined)
      return "retry"
    }
    this.#retryMs = RETRY_MS.first
    if (this.#failing) this.#options.log?.("telemetry sending again")
    this.#failing = false
    if (response.status === 202) {
      const pause = z.object({ pauseSeconds: z.number().positive().max(7 * 86_400).optional() }).safeParse(await response.json().catch(() => ({})))
      if (!pause.data?.pauseSeconds) return "sent"
      this.#pausedUntil = this.#now() + pause.data.pauseSeconds * 1000
      this.#queue = []
      return "paused"
    }
    // A batch the cloud refuses would be refused again; a cloud without the route waits an hour.
    this.#options.log?.("telemetry batch refused", { status: response.status, events: events.length })
    if (response.status === 404) {
      this.#pausedUntil = this.#now() + 3_600_000
      this.#queue = []
      return "paused"
    }
    return "sent"
  }

  #failed(fields: HostLogFields, waitMs?: number): void {
    if (!this.#failing) this.#options.log?.("telemetry not sent; it is retried", fields)
    this.#failing = true
    this.#pausedUntil = this.#now() + (waitMs ?? this.#retryMs)
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MS.max)
  }

  #schedule(): void {
    if (this.#timer || this.#closed || !this.#queue.length) return
    const wait = Math.max(FLUSH_MS, this.#pausedUntil - this.#now())
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush()
    }, wait)
    this.#timer.unref?.()
  }

  #cancelTimer(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  /** Forced off, nothing is written: no install ID is kept. */
  async #save(): Promise<void> {
    const file = this.#options.file
    if (this.#options.off || file === undefined) return
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temporary, JSON.stringify(this.#stored), { mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      this.#options.log?.("telemetry settings not saved", { error: error instanceof Error ? error.name : "unknown" })
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

function endpointOf(cloud: string | undefined): URL | undefined {
  if (!cloud) return undefined
  try {
    return new URL("/v1/telemetry", cloud)
  } catch {
    return undefined
  }
}

/** The app's own code, whose frames say where an error is; every other path is someone's files. */
const keepPath = (path: string) => (path.includes("app.asar") ? path : "<path>")

/** The gateway scrubs with the same rules again; a change here belongs there too. */
const SCRUBS: Array<(text: string) => string> = [
  (text) => text.replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 <secret>"),
  (text) => text.replace(/\b(?:sk|pk|rk|phc|phx|xaat|xapt|ghp|gho|ghu|ghs|github_pat|mako_dc|e2b)[-_][\w-]{8,}/g, "<secret>"),
  (text) => text.replace(/\b(?:token|key|secret|password|code)=[^\s&"']+/gi, "<secret>"),
  (text) => text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"),
  (text) => text.replace(/(https?:\/\/[^\s/?#]+)[/?#][^\s"')]*/g, "$1/<path>"),
  (text) => text.replace(/(?<![\w.:/])~?\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, keepPath),
  (text) => text.replace(/\b[A-Za-z]:\\(?:[^\\\s"'():]+\\)*[^\\\s"'():]*/g, keepPath),
  (text) => text.replace(/(["'`])[^"'`\n]{40,}\1/g, "$1<text>$1"),
]

/** Secrets, emails, URLs' paths, file paths and long quoted text out of an error's words. */
export function scrub(text: string): string {
  return SCRUBS.reduce((value, rule) => rule(value), text)
}

type DiagnosticScrubs = { [Name in keyof DiagnosticEvents]: (props: DiagnosticEvents[Name]) => DiagnosticEvents[Name] }

/** Every field of a diagnostic event that holds words someone else wrote goes through `scrub`. */
const SCRUB_PROPS: DiagnosticScrubs = {
  "error.reported": ({ message, stack, breadcrumbs, ...rest }) => ({
    ...rest,
    message: scrub(message),
    ...(stack !== undefined && { stack: scrub(stack) }),
    ...(breadcrumbs && { breadcrumbs: breadcrumbs.map(scrub) }),
  }),
  "native.unknown": (props) => props,
}
