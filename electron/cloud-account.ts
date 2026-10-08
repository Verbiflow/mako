import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname } from "node:path"
import { z } from "zod"
import {
  CloudDeviceSchema,
  CloudPersonSchema,
  type CloudAccount,
  type CloudAccountState,
  type CloudDevice,
  type CloudPerson,
  type CloudSignedOutNotice,
} from "./contracts/cloud-account.js"
import type { CloudRoute, DiagnosticEvents } from "./contracts/telemetry.js"
import type { SecretEncryption } from "./secure-storage.js"

/** How long a browser sign-in may take; the cloud's sign-in request lasts as long. */
const SIGN_IN_MS = 10 * 60_000
/** A connection token is renewed this long before it expires. */
const RENEW_BEFORE_S = 60
const PING_MS = 25_000
/** No pong for this long and the connection is presumed dead, as after a laptop sleeps. */
const SILENT_MS = 60_000
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const
const REQUEST_MS = 15_000
/** The cloud logs and traces a call under this ID, so the cloud's side of any call this Mac reports can be found. */
const CORRELATION_HEADER = "x-mako-correlation-id"
/** Close codes the cloud sends: fetch a new token and reconnect, or this device is gone. */
const CLOSE = { tokenExpired: 4001, deviceRemoved: 4003 } as const

const REMOVED: CloudSignedOutNotice = {
  kind: "removed",
  message: "This Mac was removed from your Mako account. Sign in to connect it again.",
}

const ConnectionSchema = z.object({ token: z.string().min(1), expiresAt: z.number() })
const EnrollmentSchema = z.object({
  device: CloudDeviceSchema,
  credential: z.string().regex(/^mako_dc_[\w-]{43}$/),
  connection: ConnectionSchema,
  account: CloudPersonSchema,
})
const RefreshSchema = EnrollmentSchema.omit({ credential: true })
const DevicesSchema = z.object({ devices: z.array(CloudDeviceSchema), current: z.string() })
const ProblemSchema = z.object({ title: z.string(), detail: z.string().optional() }).partial()
/** Text that must be JSON, parsed and then checked against `schema`, in one step. */
const jsonText = <Schema extends z.ZodType>(schema: Schema) =>
  z
    .string()
    .transform((text, context) => {
      try {
        return JSON.parse(text)
      } catch {
        context.addIssue({ code: "custom", message: "not JSON" })
        return z.NEVER
      }
    })
    .pipe(schema)

const FrameSchema = jsonText(z.union([
  z.object({ type: z.literal("hello") }).loose(),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("token-accepted"), expiresAt: z.number() }),
  z.object({ type: z.literal("bye"), code: z.number(), reason: z.string() }),
  z.object({ type: z.literal("error") }).loose(),
]))
/** A connection token's middle segment; only its lifetime is read here, never trusted for anything else. */
const TokenClaimsSchema = z
  .string()
  .transform((segment) => Buffer.from(segment, "base64url").toString("utf8"))
  .pipe(jsonText(z.object({ iat: z.number(), exp: z.number() })))

const StoredSchema = z.object({
  version: z.literal(1),
  /** The cloud it was issued by; another cloud's credential is never sent anywhere. */
  cloud: z.string(),
  credential: z.string(),
  device: CloudDeviceSchema,
  account: CloudPersonSchema,
})
type Stored = z.infer<typeof StoredSchema>

export type CloudAccountOptions = {
  /** `MAKO_CLOUD_URL`: https, or http on this Mac's loopback. */
  url: string | undefined
  /** Where the encrypted credential is kept, in this profile's data folder. */
  storePath: string
  encryption: SecretEncryption
  openExternal: (url: string) => Promise<void>
  /** How this Mac names itself on the account's device list. */
  device: () => Promise<{ name: string; platform: string; appVersion: string }>
  /** A fixture desk reaches nothing beyond this Mac, so it signs in only to a cloud on loopback. */
  fixture?: boolean
  onChange: (account: CloudAccount) => void
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** Every call to the cloud, as it ends, for error reports. */
  onRequest?: (call: DiagnosticEvents["cloud.request"]) => void
}

export class CloudAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CloudAccountError"
  }
}

class Removed extends Error {}

type SignIn = {
  server: Server
  url: string
  startedAt: string
  timer: NodeJS.Timeout
  done: Promise<void>
  /** The first good callback's enrolment; a reloaded tab waits on the same one. */
  enrolment?: Promise<boolean>
}

/** A token and when to renew it, by this Mac's clock: a skewed clock mustn't make every token look expired. */
type HeldToken = { token: string; renewAt: number }

/**
 * The host's side of a Mako account. A browser sign-in hands this Mac a device credential
 * (RFC 8252: the cloud redirects to a loopback address with a one-time code, bound to this
 * process by PKCE). The credential is kept encrypted and buys a connection token every few
 * minutes; the token opens one WebSocket to the account, renewed in place before it expires.
 * The cloud closes it the moment this device is removed anywhere, and this Mac signs out.
 */
export class CloudAccounts {
  readonly #options: CloudAccountOptions
  readonly #cloud: URL | undefined
  readonly #unavailable: string | undefined
  #state: CloudAccountState = { status: "signed-out" }
  #stored: Stored | undefined
  #signIn: SignIn | undefined
  #token: HeldToken | undefined
  #tokenRequest: Promise<string> | undefined
  #socket: WebSocket | undefined
  #attempt = 0
  #timers = new Set<NodeJS.Timeout>()
  #lastHeard = 0
  #closed = false
  #ready: Promise<void>

  constructor(options: CloudAccountOptions) {
    this.#options = options
    const parsed = parseCloud(options.url, options.fixture === true)
    this.#cloud = parsed.url
    this.#unavailable = parsed.problem
    if (this.#unavailable) this.#state = { status: "unavailable", message: this.#unavailable }
    this.#ready = this.#cloud ? this.#resume() : Promise.resolve()
  }

  account(): CloudAccount {
    return { cloud: this.#cloud ? this.#cloud.host : null, state: this.#state }
  }

  /** Settles once a saved sign-in has been read back, so the first answer isn't a false "signed out". */
  async ready(): Promise<CloudAccount> {
    await this.#ready
    return this.account()
  }

  /** Opens the browser at the cloud's sign-in page; a second call while one is open reopens the same page. */
  async signIn(): Promise<CloudAccount> {
    const cloud = this.#require()
    await this.#ready
    if (this.#state.status === "signed-in") return this.account()
    if (this.#signIn) {
      await this.#options.openExternal(this.#signIn.url)
      return this.account()
    }
    const verifier = base64url(randomBytes(32))
    const state = base64url(randomBytes(16))
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    // SAFETY: a server listening on a TCP host and port reports an AddressInfo, never a pipe path.
    const { port } = server.address() as AddressInfo
    const device = await this.#options.device()
    const name = device.name.trim().slice(0, 80) || "Mac"
    const page = new URL("/sign-in", cloud)
    page.search = new URLSearchParams({
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      state,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      device_kind: "desktop",
      device_name: name,
      platform: device.platform.slice(0, 40),
      app_version: device.appVersion.slice(0, 40),
    }).toString()
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const startedAt = new Date().toISOString()
    const timer = setTimeout(() => this.#endSignIn({ kind: "timed-out", message: "The sign-in took too long. Try again." }), SIGN_IN_MS)
    const signIn: SignIn = { server, url: page.toString(), startedAt, timer, done }
    this.#signIn = signIn
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
      if (url.pathname !== "/callback" || request.method !== "GET") {
        response.writeHead(404).end()
        return
      }
      const returned = url.searchParams.get("state")
      const code = url.searchParams.get("code")
      const back = (result: "done" | "failed") => {
        const target = new URL("/sign-in/done", cloud)
        if (result === "failed") target.searchParams.set("result", "failed")
        response.writeHead(303, { location: target.toString(), "cache-control": "no-store", connection: "close" }).end()
      }
      // Another tab, or a page guessing the port, can't finish someone else's sign-in.
      if (returned !== state || !code || this.#signIn !== signIn) {
        back("failed")
        return
      }
      signIn.enrolment ??= this.#enroll(code, verifier).then(
        () => {
          this.#endSignIn(undefined, { graceful: true })
          finish()
          return true
        },
        (error) => {
          this.#endSignIn({ kind: "failed", message: messageOf(error, "Signing in didn't finish. Try again.") }, { graceful: true })
          finish()
          return false
        }
      )
      void signIn.enrolment.then((ok) => back(ok ? "done" : "failed"))
    })
    this.#set({ status: "signing-in", url: signIn.url, startedAt })
    this.#options.log?.("cloud sign-in started", { port })
    await this.#options.openExternal(signIn.url)
    return this.account()
  }

  /** Resolves when the sign-in in progress ends, however it ends. */
  async waitSignIn(): Promise<CloudAccount> {
    await this.#signIn?.done
    return this.account()
  }

  cancelSignIn(): CloudAccount {
    if (this.#signIn) this.#endSignIn()
    return this.account()
  }

  async devices(): Promise<{ devices: CloudDevice[]; current: string }> {
    return DevicesSchema.parse(await (await this.#call("devices.list", "GET", "/v1/devices")).json())
  }

  /** Removing this Mac is signing out; any other device of the account is cut off within seconds. */
  async removeDevice(id: string): Promise<CloudAccount> {
    if (this.#stored?.device.id === id) return this.signOut()
    await this.#call("devices.remove", "DELETE", `/v1/devices/${encodeURIComponent(id)}`)
    return this.account()
  }

  async signOut(): Promise<CloudAccount> {
    await this.#ready
    const stored = this.#stored
    if (stored) {
      // Best effort: signed out here either way, and the cloud forgets an unreachable device's credential when it's removed elsewhere.
      await this.#call("devices.remove", "DELETE", `/v1/devices/${encodeURIComponent(stored.device.id)}`).catch((error) => {
        this.#options.log?.("cloud sign-out couldn't reach the cloud", { error: messageOf(error, "unknown") })
      })
    }
    await this.#forget()
    return this.account()
  }

  /** After sleep or a network change: reconnect now rather than at the next backoff step. */
  wake(): void {
    if (this.#state.status !== "signed-in" || this.#closed) return
    if (this.#socket?.readyState === WebSocket.OPEN && Date.now() - this.#lastHeard < SILENT_MS) return
    this.#attempt = 0
    this.#reconnect(0)
  }

  close(): void {
    this.#closed = true
    if (this.#signIn) this.#endSignIn()
    this.#disconnect()
  }

  // Signing in.

  async #enroll(code: string, verifier: string): Promise<void> {
    const cloud = this.#require()
    const response = await this.#fetch("devices.enroll", new URL("/v1/devices/enroll", cloud), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
    })
    if (!response.ok) throw new CloudAccountError(await problemOf(response, "Mako couldn't finish signing in. Try again."))
    const enrollment = EnrollmentSchema.parse(await response.json())
    const stored: Stored = { version: 1, cloud: cloud.origin, credential: enrollment.credential, device: enrollment.device, account: enrollment.account }
    const saved = await this.#save(stored)
    const kept = this.#options.fixture ? "fixture" : saved ? "keychain" : "memory"
    this.#stored = stored
    this.#token = hold(enrollment.connection)
    this.#set({ status: "signed-in", account: enrollment.account, device: enrollment.device, connection: "connecting", kept })
    this.#options.log?.("cloud signed in", { device: enrollment.device.id, kept })
    this.#connect()
  }

  /** Graceful lets the browser's last redirect finish; cancelling or timing out cuts it. */
  #endSignIn(notice?: CloudSignedOutNotice, { graceful = false } = {}): void {
    const signIn = this.#signIn
    if (!signIn) return
    this.#signIn = undefined
    clearTimeout(signIn.timer)
    signIn.server.close()
    if (!graceful) signIn.server.closeAllConnections()
    if (this.#state.status === "signing-in") this.#set(notice ? { status: "signed-out", notice } : { status: "signed-out" })
  }

  // The credential.

  async #resume(): Promise<void> {
    const stored = await this.#load().catch((error) => {
      this.#options.log?.("cloud sign-in couldn't be read back", { error: messageOf(error, "unknown") })
      return undefined
    })
    if (!stored || this.#closed) return
    this.#stored = stored
    this.#set({ status: "signed-in", account: stored.account, device: stored.device, connection: "connecting", kept: "keychain" })
    this.#connect()
  }

  async #load(): Promise<Stored | undefined> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.#options.storePath)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
    if (!(await this.#options.encryption.available())) return undefined
    const stored = StoredSchema.parse(JSON.parse(await this.#options.encryption.decrypt(bytes)))
    return stored.cloud === this.#cloud?.origin ? stored : undefined
  }

  /** False when the keychain is unavailable: the credential then lives in memory, until Mako quits. */
  async #save(stored: Stored): Promise<boolean> {
    if (!(await this.#options.encryption.available())) return false
    const payload = await this.#options.encryption.encrypt(JSON.stringify(stored))
    await mkdir(dirname(this.#options.storePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.#options.storePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, payload, { mode: 0o600 })
      await rename(temporary, this.#options.storePath)
    } finally {
      await rm(temporary, { force: true })
    }
    return true
  }

  async #forget(notice?: CloudSignedOutNotice): Promise<void> {
    this.#stored = undefined
    this.#token = undefined
    this.#disconnect()
    await rm(this.#options.storePath, { force: true })
    this.#set(notice ? { status: "signed-out", notice } : { status: "signed-out" })
  }

  /** The credential stopped working: removed from this account, here or on another device. */
  async #removed(): Promise<void> {
    if (!this.#stored) return
    this.#options.log?.("cloud device removed", { device: this.#stored.device.id })
    await this.#forget(REMOVED)
  }

  // Connection tokens.

  /** A connection token while this Mac is signed in, for a request that is fine without one; never throws. */
  async optionalConnectionToken(): Promise<string | undefined> {
    await this.#ready
    if (this.#state.status !== "signed-in") return undefined
    return this.#connectionToken().catch(() => undefined)
  }

  /** One refresh at a time; every caller waiting on it gets the same token. */
  #connectionToken(): Promise<string> {
    if (this.#token && this.#token.renewAt > Date.now()) return Promise.resolve(this.#token.token)
    this.#tokenRequest ??= this.#refresh().finally(() => (this.#tokenRequest = undefined))
    return this.#tokenRequest
  }

  async #refresh(): Promise<string> {
    const stored = this.#stored
    if (!stored) throw new Removed()
    const response = await this.#fetch("devices.token", new URL("/v1/devices/token", this.#require()), {
      method: "POST",
      headers: { authorization: `Bearer ${stored.credential}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
    })
    if (response.status === 401) {
      await this.#removed()
      throw new Removed()
    }
    if (!response.ok) throw new CloudAccountError(await problemOf(response, "The Mako cloud didn't answer."))
    const refreshed = RefreshSchema.parse(await response.json())
    if (this.#stored !== stored) throw new Removed()
    this.#token = hold(refreshed.connection)
    this.#stored = { ...stored, account: refreshed.account, device: refreshed.device }
    if (this.#state.status === "signed-in" && (!sameJson(this.#state.account, refreshed.account) || !sameJson(this.#state.device, refreshed.device)))
      this.#set({ ...this.#state, account: refreshed.account, device: refreshed.device })
    return refreshed.connection.token
  }

  async #call(route: CloudRoute, method: "GET" | "DELETE", path: string, retried = false): Promise<Response> {
    const token = await this.#connectionToken().catch((error) => {
      throw error instanceof Removed ? new CloudAccountError("This Mac isn't signed in to Mako.") : error
    })
    const response = await this.#fetch(route, new URL(path, this.#require()), {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
    })
    // The token can lapse between being handed out and arriving; one fresh one settles it.
    if (response.status === 401 && !retried) {
      if (this.#token?.token === token) this.#token = undefined
      return this.#call(route, method, path, true)
    }
    if (!response.ok) throw new CloudAccountError(await problemOf(response, "The Mako cloud refused that."))
    return response
  }

  /** Every call to the cloud: sent under a fresh correlation ID, and reported when it ends. */
  async #fetch(route: CloudRoute, url: URL, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
    const correlationId = randomUUID()
    const started = performance.now()
    const report = (outcome: DiagnosticEvents["cloud.request"]["outcome"], status?: number) => {
      const ms = Math.round(performance.now() - started)
      this.#options.onRequest?.({ route, outcome, ...(status !== undefined && { status }), ms, correlationId })
      if (outcome !== "ok") this.#options.log?.("cloud request", { route, outcome, ...(status !== undefined && { status }), ms, correlationId })
    }
    let response: Response
    try {
      response = await fetch(url, { ...init, headers: { ...init.headers, [CORRELATION_HEADER]: correlationId } })
    } catch (error) {
      report("unreachable")
      throw error
    }
    report(response.ok ? "ok" : response.status < 500 ? "refused" : "failed", response.status)
    return response
  }

  // The live connection.

  #connect(): void {
    if (this.#closed || !this.#stored || this.#socket) return
    void this.#connectionToken().then(
      (token) => {
        if (this.#closed || !this.#stored || this.#socket) return
        const url = new URL("/v1/connect", this.#require())
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        const socket = new WebSocket(url, ["mako.v1", `mako.token.${token}`])
        this.#socket = socket
        this.#lastHeard = Date.now()
        socket.addEventListener("message", (event) => this.#onFrame(socket, FrameSchema.safeParse(event.data)))
        socket.addEventListener("close", (event) => this.#onClose(socket, event.code))
      },
      (error) => {
        if (error instanceof Removed) return
        this.#connection("offline")
        this.#reconnect()
      }
    )
  }

  #onFrame(socket: WebSocket, frame: z.ZodSafeParseResult<z.output<typeof FrameSchema>>): void {
    if (socket !== this.#socket) return
    this.#lastHeard = Date.now()
    if (!frame.success) return
    switch (frame.data.type) {
      case "hello":
        this.#attempt = 0
        this.#connection("connected")
        this.#keepAlive(socket)
        this.#scheduleRenewal(socket)
        return
      case "token-accepted":
        this.#scheduleRenewal(socket)
        return
      case "bye":
        // Said before the close frame, which a proxy may hold back for seconds.
        this.#onClose(socket, frame.data.code)
        return
      default:
        return
    }
  }

  #onClose(socket: WebSocket, code: number): void {
    if (socket !== this.#socket) return
    this.#socket = undefined
    this.#clearTimers()
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    if (this.#closed || !this.#stored) return
    if (code === CLOSE.deviceRemoved) {
      void this.#removed()
      return
    }
    if (code === CLOSE.tokenExpired) {
      this.#token = undefined
      // At once the first time; a cloud that keeps refusing fresh tokens gets the backoff.
      this.#reconnect(this.#attempt === 0 ? 0 : undefined)
      return
    }
    this.#connection("offline")
    this.#reconnect()
  }

  #reconnect(delay: number = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 30_000): void {
    this.#attempt += 1
    this.#disconnect()
    // Jitter, so a cloud restart isn't met by every Mac at once.
    this.#after(delay === 0 ? 0 : delay * (0.8 + Math.random() * 0.4), () => this.#connect())
  }

  #keepAlive(socket: WebSocket): void {
    const tick = () => {
      if (socket !== this.#socket) return
      if (Date.now() - this.#lastHeard > SILENT_MS) {
        this.#onClose(socket, 1006)
        return
      }
      socket.send('{"type":"ping"}')
      this.#after(PING_MS, tick)
    }
    this.#after(PING_MS, tick)
  }

  /** A fresh token is handed over the open socket, so a healthy connection is never torn down to renew. */
  #scheduleRenewal(socket: WebSocket): void {
    const renewAt = this.#token?.renewAt
    if (!renewAt) return
    this.#after(Math.max(1_000, renewAt - Date.now()), () => {
      if (socket !== this.#socket) return
      void this.#connectionToken().then(
        (token) => {
          if (socket === this.#socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "token", token }))
        },
        () => {
          if (socket === this.#socket) this.#onClose(socket, 1006)
        }
      )
    })
  }

  #disconnect(): void {
    this.#clearTimers()
    const socket = this.#socket
    this.#socket = undefined
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close(1000)
  }

  #after(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      run()
    }, ms)
    timer.unref?.()
    this.#timers.add(timer)
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
  }

  // State.

  #connection(connection: "connecting" | "connected" | "offline"): void {
    if (this.#state.status === "signed-in" && this.#state.connection !== connection) this.#set({ ...this.#state, connection })
  }

  #set(state: CloudAccountState): void {
    this.#state = state
    this.#options.onChange(this.account())
  }

  #require(): URL {
    if (!this.#cloud) throw new CloudAccountError(this.#unavailable ?? "Mako accounts aren't available in this build.")
    return this.#cloud
  }
}

/** Lifetime from the token's own `iat` and `exp`, both the cloud's clock, so this Mac's clock only measures the interval. */
function hold(connection: { token: string; expiresAt: number }): HeldToken {
  const claims = TokenClaimsSchema.safeParse(connection.token.split(".")[1] ?? "")
  const lifetime = claims.success ? claims.data.exp - claims.data.iat : connection.expiresAt - Date.now() / 1000
  return { token: connection.token, renewAt: Date.now() + Math.max(lifetime - RENEW_BEFORE_S, lifetime / 2, 1) * 1000 }
}

type CloudTarget = { url: URL; problem?: never } | { url?: never; problem: string }

function parseCloud(value: string | undefined, fixture: boolean): CloudTarget {
  if (!value) return { problem: "Mako accounts aren't available in this build yet." }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { problem: "MAKO_CLOUD_URL isn't a URL." }
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    return { problem: "MAKO_CLOUD_URL must use https, or http on this Mac." }
  if (fixture && !loopback) return { problem: "A fixture desk signs in only to a Mako cloud running on this Mac." }
  return { url: new URL(url.origin) }
}

async function problemOf(response: Response, fallback: string): Promise<string> {
  const problem = ProblemSchema.safeParse(await response.json().catch(() => undefined))
  const title = problem.success ? problem.data.title : undefined
  return title ? (problem.data?.detail ? `${title}. ${problem.data.detail}` : title) : fallback
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

/** Only the cloud's own sentences and timeouts reach people; anything else becomes `fallback`. */
function messageOf(error: Error | undefined, fallback: string): string {
  return error instanceof CloudAccountError ? error.message : error instanceof Error && error.name === "TimeoutError" ? "The Mako cloud didn't answer in time." : fallback
}

function sameJson(a: CloudPerson | CloudDevice, b: CloudPerson | CloudDevice): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
