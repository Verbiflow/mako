import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { basename, join } from "node:path"
import { z } from "zod"
import {
  type ClientEndpoint,
  type ClientSessionOverSockets,
  type ConnectionCredential,
  type Problem,
  clientSessionOverSockets,
  type RuntimeLink,
  RuntimeRefusedError,
  type ServedRuntime,
  WireError,
  decodeGatewayClientFrame,
  encodeClientFrame,
  problemType,
  renewal,
  runtimeLinkOverSocket,
} from "@mako/protocol"
import {
  CloudDeviceSchema,
  CloudPersonSchema,
  type CloudAccount,
  type CloudAccountState,
  type CloudDevice,
  type CloudPerson,
  type CloudSignedOutNotice,
} from "../contracts/cloud-account.js"
import type { CloudRoute, DiagnosticEvents } from "../contracts/telemetry.js"
import { SecretLocked, type LegacyFiles, type SecretRecord, type Secrets } from "../base/secrets.js"
import { CONNECT_PROTOCOL, CloudLink, PING_MS, TOKEN_PROTOCOL_PREFIX, type CloudLinkAttachment, type CloudLinkEnding, type CloudLinkOptions, type CloudLinkState } from "./cloud-link.js"

/** How long a browser sign-in may take; the cloud's sign-in request lasts as long. */
const SIGN_IN_MS = 10 * 60_000
/** A connection token is renewed this long before it expires. */
const RENEW_BEFORE_S = 60
const REQUEST_MS = 15_000
/** The cloud logs and traces a call under this ID, so the cloud's side of any call this Mac reports can be found. */
const CORRELATION_HEADER = "x-mako-correlation-id"
/** What an account may use beyond this Mac: with it, this Mac is reachable from the account's other devices and the cloud. */
const CLOUD_ENTITLEMENT = "cloud"
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

/** Every frame is text; a binary message isn't one. */
const TextSchema = z.string()
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

/** The record a host's sign-in is kept under; each data root signs in as its own device. */
export function cloudSignInName(dataRoot: string): string {
  const host = basename(dataRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64)
  return `cloud/${host || "host"}`
}

/** Where older builds sealed the sign-in: `cloud-account` in the data root. */
export function cloudLegacyFiles(dataRoot: string): LegacyFiles {
  return {
    path: (kind, name) => (kind === "mako-sign-in" && name === cloudSignInName(dataRoot) ? join(dataRoot, "cloud-account") : null),
    names: async () => [],
  }
}

/** A Thread this Mac's runtime runs, and under which generation: claimed again when its link comes back. */
export type RuntimeClaim = { threadId: string; generation: number }

/** How this Mac serves the host to the cloud as a runtime: the host's own dispatcher, behind the protocol. */
export type CloudRuntime = {
  serve(link: RuntimeLink, options: { runtimeId: string; credential: ConnectionCredential; threads: RuntimeClaim[] }): Promise<ServedRuntime>
}

export type CloudAccountOptions = {
  /** `MAKO_CLOUD_URL`: https, or http on this Mac's loopback. */
  url: string | undefined
  /** Where the device credential is kept: a `mako-sign-in` record, one per data root. */
  secrets: Secrets
  secretName: string
  openExternal: (url: string) => Promise<void>
  /** How this Mac names itself on the account's device list. */
  device: () => Promise<{ name: string; platform: string; appVersion: string }>
  /** A fixture desk reaches nothing beyond this Mac, so it signs in only to a cloud on loopback. */
  fixture?: boolean
  onChange: (account: CloudAccount) => void
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** Every call to the cloud, as it ends, for error reports. */
  onRequest?: (call: DiagnosticEvents["cloud.request"]) => void
  /** With the cloud entitlement, this Mac is reachable from the cloud as a runtime, `d-<device>`. */
  runtime?: CloudRuntime
  /** A connection down this long shows as offline; a shorter blip isn't shown. For tests. */
  offlineAfterMs?: number
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
 * minutes; the token opens a WebSocket to the account, renewed in place before it expires
 * (`renew`, `@mako/protocol`). The cloud closes it the moment this device is removed anywhere,
 * and this Mac signs out. With the cloud entitlement, a second link serves this Mac's host to
 * the cloud as its runtime, the same way. Each link comes back by itself (`cloud-link.ts`),
 * and a reconnect over in seconds is never shown.
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
  #accountLink: CloudLink | undefined
  #runtimeLink: CloudLink | undefined
  /** The Threads this Mac's runtime ran when its link last ended, claimed again when it comes back. */
  #claims: RuntimeClaim[] = []
  readonly #sessions = new Set<ClientSessionOverSockets>()
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
    this.#accountLink?.wake()
    this.#runtimeLink?.wake()
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
    const { secrets, secretName } = this.#options
    let record: SecretRecord | null
    try {
      record = await secrets.read("mako-sign-in", secretName)
    } catch (error) {
      if (error instanceof SecretLocked && error.reason === "unavailable") return undefined
      throw error
    }
    if (!record) return undefined
    const stored = StoredSchema.parse(JSON.parse(record.value))
    return stored.cloud === this.#cloud?.origin ? stored : undefined
  }

  /** False when the keychain is unavailable: the credential then lives in memory, until Mako quits. */
  async #save(stored: Stored): Promise<boolean> {
    const { secrets, secretName } = this.#options
    if (!(await secrets.durable())) return false
    await secrets.write("mako-sign-in", secretName, JSON.stringify(stored))
    return true
  }

  async #forget(notice?: CloudSignedOutNotice): Promise<void> {
    this.#stored = undefined
    this.#token = undefined
    this.#disconnect()
    await this.#options.secrets.delete("mako-sign-in", this.#options.secretName)
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

  /**
   * Calls and subscriptions through the cloud as this device, to a Thread, a runtime or the account. Each connection
   * opens when first used, with a token from the same supply as the links, and renews it in its socket. One the cloud
   * ends for an expired token opens again on the next call; one ended because this device was removed signs it out.
   * Signing out closes every session.
   */
  session(): ClientSessionOverSockets {
    const cloud = this.#require()
    const session = clientSessionOverSockets(
      async (endpoint) => new WebSocket(new URL(endpointPath(endpoint), cloud), [CONNECT_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${await this.#connectionToken()}`]),
      {
        credential: this.#credential(),
        heartbeatMs: PING_MS,
        onClosing: (_endpoint, reason) => {
          const ending = endingOf(reason)
          if (ending === "removed") void this.#removed()
          else if (ending === "expired") this.#token = undefined
        },
      }
    )
    this.#sessions.add(session)
    return {
      ...session,
      close: () => {
        this.#sessions.delete(session)
        session.close()
      },
    }
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
    // An upgrade, or its end, reaches this Mac with its next token: the runtime's link follows it.
    this.#syncRuntime()
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

  // The live connections.

  /** The account's link, and the runtime's where the account has the cloud. */
  #connect(): void {
    const stored = this.#stored
    if (this.#closed || !stored) return
    this.#accountLink ??= this.#link("account", `/v1/accounts/${encodeURIComponent(stored.account.id)}/connect`, (socket, end) => this.#attachAccount(socket, end))
    this.#accountLink.start()
    this.#syncRuntime()
  }

  /** The runtime's link runs while the account has the cloud, and only then: an account without it never sees any of it. */
  #syncRuntime(): void {
    const stored = this.#stored
    const wanted = !this.#closed && stored !== undefined && this.#options.runtime !== undefined && stored.account.entitlements.includes(CLOUD_ENTITLEMENT)
    if (wanted && !this.#runtimeLink) {
      const runtimeId = `d-${stored.device.id}`
      this.#runtimeLink = this.#link("runtime", `/v1/runtimes/${runtimeId}/connect`, (socket, end) => this.#attachRuntime(runtimeId, socket, end))
      this.#runtimeLink.start()
      this.#options.log?.("cloud runtime link started", { runtimeId })
    } else if (!wanted && this.#runtimeLink) {
      this.#runtimeLink.stop()
      this.#runtimeLink = undefined
      this.#claims = []
      this.#options.log?.("cloud runtime link stopped")
    }
    this.#reportConnection()
  }

  #link(name: string, path: string, attach: CloudLinkOptions["attach"]): CloudLink {
    const options: CloudLinkOptions = {
      name,
      url: new URL(path, this.#require()),
      token: () => this.#connectionToken(),
      refused: (token) => {
        if (this.#token?.token === token) this.#token = undefined
      },
      attach,
      removed: () => void this.#removed(),
      onState: () => this.#reportConnection(),
      signedIn: () => this.#stored !== undefined,
    }
    if (this.#options.log) options.log = this.#options.log
    if (this.#options.offlineAfterMs !== undefined) options.offlineAfterMs = this.#options.offlineAfterMs
    return new CloudLink(options)
  }

  /** The token supply every link renews from: one refresh at a time, shared by them all. */
  #credential(): ConnectionCredential {
    return { token: () => this.#connectionToken(), renewInMs: () => (this.#token?.renewAt ?? 0) - Date.now() }
  }

  /** The account's connection: its token renewed in place, and the cloud's word when it ends it. */
  #attachAccount(socket: WebSocket, end: (ending: CloudLinkEnding) => void): CloudLinkAttachment {
    const renewing = renewal(this.#credential(), (token) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeClientFrame({ type: "renew", token }))
    })
    socket.addEventListener("message", (event) => {
      const text = TextSchema.safeParse(event.data)
      if (!text.success) return
      let frame
      try {
        frame = decodeGatewayClientFrame(text.data)
      } catch (error) {
        if (error instanceof WireError) return
        throw error
      }
      if (frame.type === "renewed") renewing.renewed()
      else if (frame.type === "closing") end(endingOf(frame.problem))
    })
    return { close: () => renewing.stop() }
  }

  /** This Mac's runtime: the host served to the cloud, claiming again the Threads it ran when the link last ended. */
  #attachRuntime(runtimeId: string, socket: WebSocket, end: (ending: CloudLinkEnding) => void): CloudLinkAttachment {
    const runtime = this.#options.runtime
    const link = runtimeLinkOverSocket(socket)
    let served: ServedRuntime | undefined
    let closed = false
    if (runtime)
      runtime.serve(link, { runtimeId, credential: this.#credential(), threads: this.#claims }).then(
        (started) => {
          served = started
          if (closed) return started.close()
          this.#options.log?.("cloud runtime enrolled", { runtimeId, claims: this.#claims.length })
          void started.ended.then((problem) => {
            this.#claims = started.claims()
            end(endingOf(problem))
          })
        },
        (error) => end(error instanceof RuntimeRefusedError ? endingOf(error.problem) : "lost")
      )
    return {
      close: () => {
        closed = true
        if (served) this.#claims = served.claims()
        link.close()
      },
    }
  }

  /** One state for both links, the account's leading: a runtime still connecting doesn't make this Mac look offline. */
  #reportConnection(): void {
    const account = this.#accountLink?.state ?? "connecting"
    const runtime = this.#runtimeLink?.state
    const connection: CloudLinkState = account === "connected" && runtime === "offline" ? "offline" : account
    this.#connection(connection)
  }

  #disconnect(): void {
    this.#accountLink?.stop()
    this.#accountLink = undefined
    this.#runtimeLink?.stop()
    this.#runtimeLink = undefined
    this.#claims = []
    for (const session of this.#sessions) session.close()
    this.#sessions.clear()
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

/** How the cloud ended a link: a removed device signs out; an expired token is fetched fresh; anything else reconnects. */
/** Where the cloud takes a session's connection to each endpoint. */
function endpointPath(endpoint: ClientEndpoint): string {
  if (endpoint.kind === "thread") return `/v1/threads/${encodeURIComponent(endpoint.threadId)}/connect`
  if (endpoint.kind === "runtime") return `/v1/runtimes/${encodeURIComponent(endpoint.runtimeId)}/clients`
  return `/v1/accounts/${encodeURIComponent(endpoint.accountId)}/connect`
}

function endingOf(problem: Problem | undefined): CloudLinkEnding {
  if (!problem) return "lost"
  const type = problemType(problem)
  return type === "forbidden" ? "removed" : type === "unauthorized" ? "expired" : "lost"
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
