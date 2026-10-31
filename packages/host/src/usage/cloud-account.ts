import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createReadStream, createWriteStream } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { basename, join } from "node:path"
import { AccountEventSchema, accountStream, type AccountEvent } from "@mako/protocol/account-events"
import { ACCESS_CHOICES_PATH, AccessChoicesAnswerSchema, type AccessChoices as AccountAccessChoices, type AccessChoicesAnswer } from "@mako/protocol/access-choices"
import { CORRELATION_HEADER } from "@mako/protocol/gateway-http"
import { SessionListingsSchema, type SessionListings } from "@mako/protocol/thread-listing"
import { WaitingInputSchema, WaitingMessageSchema, type WaitingInput, type WaitingMessage } from "@mako/protocol/waiting"
import type { SessionPublishing } from "./machine-runtime.js"
import { MOVE_ANSWER_WAIT_MS, MoveAnswerSchema, MoveHandOverRequestSchema, MoveHandOverStateSchema, ReturnReleaseRequestSchema, ReturnStateSchema, type MoveAnswer, type MoveCheckpoint, type MoveHandOverRequest, type MoveHandOverState, type ReturnDeparture, type ReturnState } from "@mako/protocol/moves"
import type { RecordsLink } from "@mako/sessions/record-sync"
import { Agent, fetch as fetchWith, type Response as CloudResponse } from "undici"
import { z } from "zod"
import {
  type ClientEndpoint,
  type ClientSessionOverSockets,
  type ConnectionCredential,
  type EventFrame,
  type Problem,
  clientSessionOverSockets,
  type RuntimeLink,
  RuntimeRefusedError,
  type GoingQuietReason,
  type ServedRuntime,
  WireError,
  decodeGatewayClientFrame,
  encodeClientFrame,
  problemType,
  renewal,
  runtimeLinkOverSocket,
  subprotocols,
  PROBE_ANSWER_MS,
  SILENT_WHILE_WORKING_MS,
} from "@mako/protocol"
import {
  CloudBrowserSessionSchema,
  CloudDeviceSchema,
  CloudPersonSchema,
  type CloudAccount,
  type CloudAccountState,
  type CloudBrowserSession,
  type CloudDevice,
  type CloudPerson,
  type CloudSignedOutNotice,
} from "../contracts/cloud-account.js"
import {
  CloudKeptSignInSchema,
  CloudShareOutcomeSchema,
  CloudSharedChainSchema,
  CloudSignInListingSchema,
  type CloudKeptSignIn,
  type CloudShareOutcome,
  type CloudSharedChain,
  type CloudSignIn,
  type CloudSignInChain,
  type CloudSignInHarness,
  type CloudSignInListing,
} from "../contracts/cloud-sign-ins.js"
import { clipReason, CloudRepositorySchema, type CloudRepository } from "../contracts/cloud-threads.js"
import type { BaseStanding } from "../contracts/cloud-turn-on.js"
import { CloudCarriedFileSchema, type CloudCarriedFile } from "../contracts/cloud-carried-files.js"
import { GitHubTokenAnswerSchema, GitHubTokenListingSchema, type GitHubTokenListing } from "../contracts/github-person.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import type { CloudRoute, DiagnosticEvents } from "../contracts/telemetry.js"
import { CloudHarnessesSchema, type CloudHarnesses } from "../contracts/cloud-harnesses.js"
import { errorMessage } from "../base/error-message.js"
import { SecretLocked, type LegacyFiles, type SecretRecord, type Secrets } from "../base/secrets.js"
import { RequestTraces } from "./request-trace.js"
import { CloudLink, PING_MS, type CloudLinkAttachment, type CloudLinkEnding, type CloudLinkOptions, type CloudLinkState } from "./cloud-link.js"

/** How long a browser sign-in may take; the cloud's sign-in request lasts as long. */
const SIGN_IN_MS = 10 * 60_000
/** A connection token is renewed this long before it expires. */
const RENEW_BEFORE_S = 60
const REQUEST_MS = 15_000
/** The slowest upload a move waits for before giving up: 100 KB a second. */
const UPLOAD_BYTES_PER_MS = 100
/** A call to the cloud: JSON in and out, never redirected, bounded in time. */
type CloudRequest = { method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"; headers: Record<string, string>; body?: string | Readable; duplex?: "half"; redirect: "error"; signal: AbortSignal }

/**
 * A file's bytes as a request's body, such as a move's checkpoint: read afresh for each attempt, its length given.
 * `sent`, told how many bytes have gone into the request so far, as they go.
 */
class FileBody {
  readonly file: string
  readonly bytes: number
  readonly sent: ((bytes: number) => void) | undefined
  constructor(file: string, bytes: number, sent?: (bytes: number) => void) {
    this.file = file
    this.bytes = bytes
    this.sent = sent
  }
}

/** A file's bytes as they're read into a request, counted to `sent`. */
async function* countedFile(file: string, sent: (bytes: number) => void): AsyncGenerator<Buffer> {
  let total = 0
  for await (const chunk of createReadStream(file)) {
    // SAFETY: a file stream with no encoding yields Buffers.
    const bytes = chunk as Buffer
    total += bytes.length
    sent(total)
    yield bytes
  }
}

/** A call to the cloud slower than this is logged, though it succeeded. */
const SLOW_REQUEST_MS = 2_000
/** What an account may use beyond this Mac: with it, this Mac is reachable from the account's other devices and the cloud. */
const CLOUD_ENTITLEMENT = "cloud"
const REMOVED: CloudSignedOutNotice = {
  kind: "removed",
  message: "This Mac was removed from your Mako account. Sign in to connect it again.",
}
const REUSED: CloudSignedOutNotice = {
  kind: "reused",
  message: "This Mac's sign-in was used from somewhere else, so Mako signed it out to keep your account safe. Sign in again, then check Devices for any you don't know.",
}

const ConnectionSchema = z.object({ token: z.string().min(1), expiresAt: z.number() })
/** A number a stream's object may have given out but never kept, which it says in its place (`{"type":"lost"}`). */
const LostEventSchema = z.object({ type: z.literal("lost") }).loose()
const EnrollmentSchema = z.object({
  device: CloudDeviceSchema,
  credential: z.string().regex(/^mako_dc_[\w-]{43}$/),
  connection: ConnectionSchema,
  account: CloudPersonSchema,
})
/** `credential`: a successor to this Mac's credential, once it's due to rotate; the old one works until it's used. */
const RefreshSchema = EnrollmentSchema.omit({ credential: true }).extend({ credential: z.string().regex(/^mako_dc_[\w-]{43}$/).optional() })
const DevicesSchema = z.object({ devices: z.array(CloudDeviceSchema), current: z.string() })
/** Where on GitHub its person gives the cloud access to a repository: a GitHub page, or nothing. */
const InstallSchema = z.url({ protocol: /^https$/, hostname: /^github\.com$/ }).optional().catch(undefined)
/** Read leniently: a state this build doesn't know reads as the cloud not saying. */
const BaseStandingSchema = z.union([
  z.object({ state: z.literal("ready"), madeAt: z.string() }),
  z.object({ state: z.literal("making"), since: z.string() }),
  z.object({ state: z.literal("waiting"), message: z.string().optional(), retryAt: z.string().optional(), reason: z.literal("no-access").optional().catch(undefined), install: InstallSchema }),
  z.object({ state: z.literal("failed"), message: z.string(), reason: z.literal("no-access").optional().catch(undefined), install: InstallSchema }),
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("unknown") }),
]).catch({ state: "unknown" as const })
const BaseStandingsSchema = z.object({ bases: z.array(z.object({ repository: CloudRepositorySchema, standing: BaseStandingSchema })) })
/** What the account says of a Session's waiting messages after a change to one. */
const WaitingAnswerSchema = z.object({ messages: z.array(WaitingMessageSchema) })
const BrowserSessionsSchema = z.object({ sessions: z.array(CloudBrowserSessionSchema) })
const EndedSchema = z.object({ ended: z.number().int().nonnegative() })
/** What the cloud answers a Thread made or made again with; only whether its machine is ready is read. */
/** `ended`: a Thread standing by that the cloud ended unused; the device stands by with a new one. */
const CreatedThreadSchema = z.object({ ready: z.boolean().optional(), ended: z.boolean().optional() }).loose()
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
  /** The last event of the account's stream this device heard; it follows on from there when it connects again. */
  seen: z.number().int().nonnegative().optional(),
})
type Stored = z.infer<typeof StoredSchema>

/** A sign-out the cloud hasn't heard of yet: the device's credential, kept sealed only to remove the device there. */
const UnfinishedSignOutSchema = z.object({ version: z.literal(1), cloud: z.string(), credential: z.string(), device: z.string() })
type UnfinishedSignOut = z.infer<typeof UnfinishedSignOutSchema>
/** An unfinished sign-out is asked again this often while it lasts, and at every start and wake. */
const SIGN_OUT_RETRY_MS = 60_000
/**
 * The last account event heard is kept at most this long after it's heard, with every other heard meanwhile: a
 * keychain write for each event held each one back from delivery. The stream is said again after the kept one, and an
 * event heard twice changes nothing, so a restart within it only hears a few again.
 */
const SEEN_SAVE_MS = 2_000

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
  serve(link: RuntimeLink, options: { runtimeId: string; credential: ConnectionCredential; threads: RuntimeClaim[]; watch?: (conversations: readonly string[], after?: Readonly<Record<string, number>>) => void }): Promise<ServedRuntime>
}

/** How a cloud Thread is made: ahead of its first message (`prepare`), and the harness that message is for. */
export interface CloudThreadMaking {
  prepare?: boolean
  harness?: string
  /** For a Thread moving from this Mac: its folder here, where its machine clones the repository, so its sessions resume as they are. */
  folder?: string
  /** Kept ready for a Thread of this Mac's that may move: records and checkpoints go to it, and its machine starts only with the move. */
  standby?: boolean
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
  /** What tells the account's list of this Mac's Sessions over that runtime's link, and relays what's watched. */
  sessions?: SessionPublishing | undefined
  /** A connection down this long shows as offline; a shorter blip isn't shown. For tests. */
  offlineAfterMs?: number
  /**
   * Something happened to the account's devices (its stream, `account:<id>`): heard live, or on connecting again
   * after it happened. `mine`: about this Mac. A device that joined before this Mac did isn't news to it.
   */
  onAccountEvent?: (heard: { seq: number; at: string; event: AccountEvent; mine: boolean }) => void
  /**
   * The account's stream skipped a number, or said one was lost: what the missing event said is unknown, so what lists
   * the account reads it whole again rather than hold a list that may be wrong.
   */
  onAccountGap?: (gap: { after: number; seq: number; why: "skipped" | "lost" }) => void
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
  /** The last event of the account's stream this device heard: kept with `#stored` when it's next written. */
  #seen: number | undefined
  #seenSave: NodeJS.Timeout | undefined
  /** Every write of the sign-in to the keychain, one after another, so a later one never lands under an earlier one. */
  #writes: Promise<unknown> = Promise.resolve()
  /** A sign-out the cloud hasn't heard of, held in memory when there's no keychain to keep it in. */
  #unfinished: UnfinishedSignOut | undefined
  #finishing: NodeJS.Timeout | undefined
  #signIn: SignIn | undefined
  #token: HeldToken | undefined
  #tokenRequest: Promise<string> | undefined
  #accountLink: CloudLink | undefined
  #runtimeLink: CloudLink | undefined
  /** The Threads this Mac's runtime ran when its link last ended, claimed again when it comes back. */
  #claims: RuntimeClaim[] = []
  /** The runtime link this Mac serves on now, and what serves there: where its Sessions are reported. */
  #served: { link: RuntimeLink; served: ServedRuntime } | undefined
  readonly #sessions = new Set<ClientSessionOverSockets>()
  /**
   * Calls to the cloud go through a pool of this Mac's own, replaced at every wake: Node's timers stop while the Mac
   * sleeps, so a pooled connection the network dropped meanwhile still looks fresh, and a call put on it waits out
   * TCP's retransmissions (seconds) before it's refused and retried on a new one.
   */
  #pool = new Agent()
  /** How far each call got, for the log line of one that fails or is slow. */
  readonly #traces = new RequestTraces(CORRELATION_HEADER)
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

  /**
   * The account's Sessions as every device lists them, and the account stream's number they were read at: this Mac
   * follows the stream after it, and misses nothing between.
   */
  async sessionListings(): Promise<SessionListings> {
    return SessionListingsSchema.parse(await (await this.#call("sessions.list", "GET", "/v1/sessions")).json())
  }

  /** A message for a Session whose owner is off, kept by the account until its owner takes it (`waiting.ts`). */
  async waitMessage(session: string, id: string, input: WaitingInput): Promise<WaitingMessage[]> {
    const answer = await this.#call("messages.wait", "PUT", `/v1/sessions/${encodeURIComponent(session)}/waiting/${encodeURIComponent(id)}`, WaitingInputSchema.parse(input))
    return WaitingAnswerSchema.parse(await answer.json()).messages
  }

  /** A waiting message's words, changed while they're still `expectedText`. */
  async editWaiting(session: string, id: string, expectedText: string, text: string): Promise<WaitingMessage[]> {
    const answer = await this.#call("messages.edit", "POST", `/v1/sessions/${encodeURIComponent(session)}/waiting/${encodeURIComponent(id)}/edit`, { expectedText, text })
    return WaitingAnswerSchema.parse(await answer.json()).messages
  }

  /** A waiting message taken back. */
  async unwaitMessage(session: string, id: string): Promise<WaitingMessage[]> {
    const answer = await this.#call("messages.unwait", "DELETE", `/v1/sessions/${encodeURIComponent(session)}/waiting/${encodeURIComponent(id)}`)
    return WaitingAnswerSchema.parse(await answer.json()).messages
  }

  /** Its owner took it, as a request of the Session under the same ID. */
  async tookWaiting(session: string, id: string): Promise<void> {
    await this.#call("messages.taken", "POST", `/v1/sessions/${encodeURIComponent(session)}/waiting/${encodeURIComponent(id)}/taken`, {})
  }

  /**
   * A watched conversation's update went out on the runtime link: one silent a while is asked whether it's alive, so a
   * stalled link the watchers wait on is replaced in seconds.
   */
  liveSent(): void {
    this.#runtimeLink?.probeIfSilent(SILENT_WHILE_WORKING_MS, PROBE_ANSWER_MS)
  }

  /** Tells the account's list what changed of this Mac's Sessions, on the runtime link it serves now (none while signed out). */
  reportSessions(): void {
    this.#options.sessions?.report(this.#served)
  }

  /**
   * The harness versions the cloud's machines run: the record of the image it makes them from. Null from a cloud that
   * doesn't say (one older than saying it, or one that names no image).
   */
  async cloudHarnesses(): Promise<CloudHarnesses | null> {
    const response = await this.#call("cloud.harnesses", "GET", "/v1/cloud/harnesses", undefined, false, [404])
    return response.status === 404 ? null : CloudHarnessesSchema.parse(await response.json())
  }

  /** The person's access choice per harness, as the account keeps them; null from a cloud that doesn't keep them yet. */
  async accessChoices(): Promise<AccessChoicesAnswer | null> {
    const response = await this.#call("access.read", "GET", ACCESS_CHOICES_PATH, undefined, false, [404])
    return response.status === 404 ? null : AccessChoicesAnswerSchema.parse(await response.json())
  }

  /** Makes `choices` the account's, or with `fill` only where it has none yet; all of them after, or null as above. */
  async chooseAccess(choices: AccountAccessChoices, fill: boolean): Promise<AccessChoicesAnswer | null> {
    const response = await this.#call("access.choose", "PATCH", ACCESS_CHOICES_PATH, { choices, ...fill && { fill } }, false, [404])
    return response.status === 404 ? null : AccessChoicesAnswerSchema.parse(await response.json())
  }

  async devices(): Promise<{ devices: CloudDevice[]; current: string }> {
    return DevicesSchema.parse(await (await this.#call("devices.list", "GET", "/v1/devices")).json())
  }

  /**
   * The account's store of harness sign-ins, which its cloud machines run under: why this Mac can't use it now
   * (signed out, or an account without the cloud), or undefined when it can.
   */
  async signInsBlocked(): Promise<"signed-out" | "no-cloud" | undefined> {
    await this.#ready
    if (this.#state.status !== "signed-in") return "signed-out"
    return this.#state.account.entitlements.includes(CLOUD_ENTITLEMENT) ? undefined : "no-cloud"
  }

  /** The sign-ins the account's store holds, and those the cloud keeps by itself, without their values. */
  async signIns(): Promise<{ signIns: CloudSignInListing[]; kept: CloudKeptSignIn[] }> {
    const ListedSchema = z.object({ signIns: z.array(CloudSignInListingSchema), kept: z.array(CloudKeptSignInSchema).default([]) })
    return ListedSchema.parse(await (await this.#call("sign-ins.list", "GET", `${this.#signInsPath()}`)).json())
  }

  /** This Mac's whole sign-in, for the cloud to refresh for both: it takes it, has it, or answers with what's newer. */
  async shareSignIn(harness: CloudSignInHarness, chain: CloudSignInChain): Promise<CloudShareOutcome> {
    const response = await this.#call("sign-ins.share", "PUT", `${this.#accountPath()}/cloud-sign-ins/${harness}`, { harness, ...chain, shared: true })
    return CloudShareOutcomeSchema.parse(await response.json())
  }

  /** The whole pair of a sign-in this Mac shares, as the cloud last refreshed it; null when it keeps none for this Mac. */
  async pullSignIn(harness: CloudSignInHarness): Promise<CloudSharedChain | null> {
    const response = await this.#call("sign-ins.pull", "GET", `${this.#accountPath()}/cloud-sign-ins/${harness}/chain`, undefined, false, [404])
    return response.status === 404 ? null : CloudSharedChainSchema.parse(await response.json())
  }

  /** Asks for a shared sign-in's due refresh; the new pair comes back in the answer. Null when the cloud has none of this Mac's. */
  async refreshSignIn(harness: CloudSignInHarness): Promise<CloudSharedChain | null> {
    const response = await this.#call("sign-ins.refresh", "POST", `${this.#accountPath()}/cloud-sign-ins/${harness}/refresh`, undefined, false, [404])
    return response.status === 404 ? null : CloudSharedChainSchema.parse(await response.json())
  }

  async disconnectSignIn(harness: CloudSignInHarness): Promise<void> {
    await this.#call("sign-ins.disconnect", "DELETE", `${this.#accountPath()}/cloud-sign-ins/${harness}`)
  }

  async saveSignIn(signIn: CloudSignIn): Promise<void> {
    await this.#call("sign-ins.save", "PUT", `${this.#signInsPath()}/${signIn.harness}`, signIn)
  }

  async removeSignIn(harness: CloudSignInHarness): Promise<void> {
    await this.#call("sign-ins.remove", "DELETE", `${this.#signInsPath()}/${harness}`)
  }

  /** "Open pull requests as me": who the account's own GitHub token belongs to, or null while it's off. Never the token. */
  async githubToken(): Promise<GitHubTokenListing | null> {
    const response = await this.#call("github-token.read", "GET", `${this.#accountPath()}/github-token`)
    return GitHubTokenAnswerSchema.parse(await response.json()).token
  }

  /**
   * Turns it on, or replaces the token: the cloud checks it with GitHub (who it belongs to, and that it reaches
   * `repository`, `owner/name`, when one is in view) and keeps it encrypted for the account's cloud machines. This Mac
   * keeps nothing of it. A refusal is GitHub's reason in words.
   */
  async saveGitHubToken(token: string, repository?: string): Promise<GitHubTokenListing> {
    const response = await this.#call("github-token.save", "PUT", `${this.#accountPath()}/github-token`, { token, ...repository && { repository } })
    return GitHubTokenListingSchema.parse(await response.json())
  }

  /** Turns it off: the account removes the token, and each cloud machine its copy before its next pull request. */
  async removeGitHubToken(): Promise<void> {
    await this.#call("github-token.remove", "DELETE", `${this.#accountPath()}/github-token`)
  }

  /** A project's carried files the account's store keeps (`?repository=`), listed without their values. */
  async carriedFiles(repository: string): Promise<CloudCarriedFile[]> {
    const response = await this.#call("carried-files.list", "GET", `${this.#accountPath()}/carried-files?repository=${encodeURIComponent(repository)}`)
    return z.object({ files: z.array(CloudCarriedFileSchema) }).parse(await response.json()).files
  }

  /** One of a project's carried files, sealed by the cloud and kept for the project's cloud Threads; answers its new listing. */
  async putCarriedFile(repository: string, file: { path: string; data: Buffer; names: string[] }): Promise<CloudCarriedFile> {
    const response = await this.#call("carried-files.put", "PUT", `${this.#accountPath()}/carried-files?repository=${encodeURIComponent(repository)}`, { path: file.path, data: file.data.toString("base64"), names: file.names })
    return CloudCarriedFileSchema.parse(await response.json())
  }

  /** One of a project's carried files removed from the cloud, or with no `path` all of them; answers the paths removed. */
  async removeCarriedFiles(repository: string, path?: string): Promise<string[]> {
    const query = `repository=${encodeURIComponent(repository)}${path === undefined ? "" : `&path=${encodeURIComponent(path)}`}`
    const response = await this.#call("carried-files.remove", "DELETE", `${this.#accountPath()}/carried-files?${query}`)
    return z.object({ removed: z.array(z.string()) }).parse(await response.json()).removed
  }

  /**
   * A cloud Thread in this account, its machine working in a clone of `repository`. Made again under the same ID, it's
   * the same Thread. `prepare`: made ahead of its first message as the person writes it, and asked again while they
   * do; `ready` says whether its machine runs with its runtime connected. `harness`: the one its first message is for,
   * whose start its machine runs ahead as it boots.
   */
  async createThread(threadId: string, repository: CloudRepository, options: CloudThreadMaking = {}): Promise<{ ready: boolean; ended?: true }> {
    const body: JsonObject = { threadId, home: "cloud", repository }
    if (options.prepare) body.prepare = true
    if (options.harness) body.harness = options.harness
    if (options.folder) body.folder = options.folder
    if (options.standby) body.standby = true
    const response = await this.#call(options.prepare ? "threads.prepare" : options.standby ? "threads.standby" : "threads.create", "POST", "/v1/threads", body)
    const answer = CreatedThreadSchema.safeParse(await response.json().catch(() => undefined))
    return { ready: answer.success && answer.data.ready === true, ...answer.success && answer.data.ended === true && { ended: true as const } }
  }

  /**
   * A move's checkpoint (or its carry, a bundle kept the same way), sent to the cloud Thread's records once: one the
   * account already has is answered without sending its bytes. The cloud keeps it only if its bytes are the ones its
   * hash names.
   */
  async sendCheckpoint(threadId: string, checkpoint: Pick<MoveCheckpoint, "sha256" | "bytes">, file: string, sent?: (bytes: number) => void): Promise<{ sent: boolean }> {
    const path = `/v1/threads/${encodeURIComponent(threadId)}/records/checkpoints/${checkpoint.sha256}`
    if ((await this.#call("moves.checkpoint", "HEAD", path, undefined, false, [404])).status === 200) return { sent: false }
    await this.#call("moves.checkpoint", "PUT", path, new FileBody(file, checkpoint.bytes, sent))
    return { sent: true }
  }

  /** The cloud's promise never to take a move, or its claim if that came first. */
  async refuseMove(threadId: string, move: string, reason: string): Promise<MoveAnswer> {
    // Within what the cloud takes, or a refusal that can never be heard leaves the move unsettled for good.
    const response = await this.#call("moves.refuse", "POST", `/v1/threads/${encodeURIComponent(threadId)}/moves/${move}/refuse`, { reason: clipReason(reason) })
    return MoveAnswerSchema.parse(await response.json())
  }

  /** A checkpoint kept beside a cloud Thread's records, read whole into `file`; its bytes are checked where it's applied. */
  async readCheckpoint(threadId: string, sha256: string, file: string): Promise<void> {
    const response = await this.#call("moves.checkpoint-read", "GET", `/v1/threads/${encodeURIComponent(threadId)}/records/checkpoints/${sha256}`)
    if (!response.body) throw new CloudAccountError("The cloud sent no checkpoint.")
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
  }

  /**
   * A cloud Thread's return to this Mac begun: from now it takes no work but its machine's departure. `to: "archive"`:
   * its person archives it, from this Mac, whichever device it came from; refused, saying why, while it works or moves.
   */
  async beginReturn(threadId: string, move: string, to?: "archive"): Promise<ReturnState> {
    return this.#returnStep("returns.begin", threadId, move, "", to ? { to } : {})
  }

  /** A return to the archive, released or with nothing to pack, archived: the cloud ends its machine and keeps its records. */
  async archiveReturn(threadId: string, move: string): Promise<ReturnState> {
    return this.#returnStep("returns.archive", threadId, move, "/archive", {})
  }

  /** The cloud Thread recorded released, with what its machine packed: nothing runs it in the cloud from now. */
  async releaseReturn(threadId: string, move: string, departure: ReturnDeparture): Promise<ReturnState> {
    return this.#returnStep("returns.release", threadId, move, "/release", ReturnReleaseRequestSchema.parse({ departure }))
  }

  /** A return given up before its release: the Thread goes on in the cloud as it was. */
  async cancelReturn(threadId: string, move: string, reason: string): Promise<ReturnState> {
    return this.#returnStep("returns.cancel", threadId, move, "/cancel", { reason: clipReason(reason) })
  }

  /** A released Thread this Mac couldn't take, given back: its machine runs it again. */
  async giveBackReturn(threadId: string, move: string, reason: string): Promise<ReturnState> {
    return this.#returnStep("returns.give-back", threadId, move, "/give-back", { reason: clipReason(reason) })
  }

  /** The return done: this Mac took the Thread, and the cloud ends its machine. */
  async finishReturn(threadId: string, move: string): Promise<ReturnState> {
    return this.#returnStep("returns.done", threadId, move, "/done", {})
  }

  /** What the cloud recorded for a return, if anything; undefined while it hasn't. */
  async returnState(threadId: string, move: string): Promise<ReturnState | undefined> {
    const response = await this.#call("returns.state", "GET", `/v1/threads/${encodeURIComponent(threadId)}/returns/${move}`, undefined, false, [404])
    return response.status === 404 ? undefined : ReturnStateSchema.parse(await response.json())
  }

  /** One step of a return; a step the record has gone past is answered with the record, which the caller reads. */
  async #returnStep(route: CloudRoute, threadId: string, move: string, step: string, body: JsonValue): Promise<ReturnState> {
    const response = await this.#call(route, "POST", `/v1/threads/${encodeURIComponent(threadId)}/returns/${move}${step}`, body, false, [409])
    const answer: unknown = await response.json()
    if (response.status === 409) {
      const record = z.object({ record: ReturnStateSchema }).safeParse(answer)
      if (!record.success) throw new CloudAccountError(problemWords(ProblemSchema.safeParse(answer).data, "The cloud refused that step of the return."))
      return record.data.record
    }
    return ReturnStateSchema.parse(answer)
  }

  /** What the cloud answered a move, if it answered; undefined while it hasn't. */
  async moveAnswer(threadId: string, move: string, waitMs = 0): Promise<MoveAnswer | undefined> {
    // Held open at the cloud until there's an answer, within this call's own time.
    const wait = Math.min(waitMs, MOVE_ANSWER_WAIT_MS, REQUEST_MS - 3_000)
    const response = await this.#call("moves.answer", "GET", `/v1/threads/${encodeURIComponent(threadId)}/moves/${move}${wait > 0 ? `?wait=${wait}` : ""}`, undefined, false, [404])
    return response.status === 404 ? undefined : MoveAnswerSchema.parse(await response.json())
  }

  /**
   * A move handed to the cloud to carry through, once this Mac sent what only it has and released the Thread
   * (`MoveHandOverRequest`): how it stands there. Posted again, the first stands.
   */
  async handOverMove(threadId: string, move: string, request: MoveHandOverRequest): Promise<MoveHandOverState> {
    // The handoff goes as JSON carries it: a field left undefined isn't sent.
    const body = MoveHandOverRequestSchema.parse({ ...request, claim: { ...request.claim, handoff: JSON.parse(JSON.stringify(request.claim.handoff)) } })
    const response = await this.#call("moves.hand-over", "POST", `/v1/threads/${encodeURIComponent(threadId)}/moves/${move}/hand-over`, body)
    return MoveHandOverStateSchema.parse(await response.json())
  }

  /**
   * Where a device's session records are kept in the account: this Mac's own, which it keeps in step with its listed
   * Sessions, or another device's, which this Mac reads a Session's copy from while that device is off.
   */
  async deviceRecords(deviceId: string): Promise<RecordsLink> {
    const base = new URL(`/v1/devices/${encodeURIComponent(deviceId)}/records`, this.#require()).toString()
    return { id: base, base, authorization: `Bearer ${await this.#connectionToken()}` }
  }

  /**
   * Where a device's originals are kept in the account: the records of its Sessions in the sync window, as their
   * harnesses wrote them, beside its copies but apart from them, so reading a copy never pulls records.
   */
  async deviceOriginals(deviceId: string): Promise<RecordsLink> {
    const base = new URL(`/v1/devices/${encodeURIComponent(deviceId)}/originals`, this.#require()).toString()
    return { id: base, base, authorization: `Bearer ${await this.#connectionToken()}` }
  }

  /** Where a cloud Thread's session records are kept, as this Mac's device reaches them, for sending a move's. */
  async threadRecords(threadId: string): Promise<RecordsLink> {
    const base = new URL(`/v1/threads/${encodeURIComponent(threadId)}/records`, this.#require()).toString()
    return { id: base, base, authorization: `Bearer ${await this.#connectionToken()}` }
  }

  /**
   * Project bases for the account's repositories, asked for ahead of their first cloud Thread: each is made in the
   * background, and a Thread whose base isn't ready yet clones as before.
   */
  async askBases(repositories: CloudRepository[]): Promise<void> {
    await this.#call("bases.ask", "POST", "/v1/bases", { repositories })
  }

  /**
   * Says whether the person is at this Mac (`cloud-attention.ts`): a notice for them waits in the account while they
   * are. A gateway from before notices doesn't know the route, and is left alone.
   */
  async attend(attending: boolean): Promise<void> {
    await this.#call("attention.put", "PUT", "/v1/attention", { attending }, false, [404])
  }

  /**
   * How the cloud stands each of these repositories' bases, read without asking for them again: one it hasn't heard of
   * reads `unknown`. Null from a cloud older than saying it.
   */
  async baseStandings(repositories: CloudRepository[]): Promise<Array<{ repository: CloudRepository; standing: BaseStanding }> | null> {
    if (!repositories.length) return []
    const response = await this.#call("bases.standing", "POST", "/v1/bases/standing", { repositories }, false, [404])
    if (response.status === 404) return null
    return BaseStandingsSchema.parse(await response.json()).bases
  }

  /**
   * Asks the cloud again what the account has, now rather than at the next connection token: an invite, or later a
   * payment, reaches this Mac at once when the person asks. The answer comes as the account's state changes.
   */
  async checkPlan(): Promise<CloudAccount> {
    await this.#ready
    if (this.#state.status !== "signed-in") return this.account()
    this.#token = undefined
    await this.#connectionToken()
    return this.account()
  }

  /** This Mac's device in the account, while it's signed in. */
  async deviceId(): Promise<string | undefined> {
    await this.#ready
    return this.#state.status === "signed-in" ? this.#state.device.id : undefined
  }

  #signInsPath(): string {
    return `${this.#accountPath()}/sign-ins`
  }

  #accountPath(): string {
    if (!this.#stored) throw new CloudAccountError("This Mac isn't signed in to Mako.")
    return `/v1/accounts/${encodeURIComponent(this.#stored.account.id)}`
  }

  /** The browsers signed in to the account on the cloud's pages, the one used last first. */
  async browserSessions(): Promise<CloudBrowserSession[]> {
    return BrowserSessionsSchema.parse(await (await this.#call("browsers.list", "GET", "/v1/browser-sessions")).json()).sessions
  }

  /** One browser signed out of the account's pages at once; one already signed out counts as done. */
  async endBrowserSession(id: string): Promise<void> {
    await this.#call("browsers.end", "DELETE", `/v1/browser-sessions/${encodeURIComponent(id)}`, undefined, false, [404])
  }

  /** Every browser signed out of the account's pages; the account's devices, this Mac included, stay signed in. */
  async endBrowserSessions(): Promise<number> {
    return EndedSchema.parse(await (await this.#call("browsers.end", "DELETE", "/v1/browser-sessions")).json()).ended
  }

  /** Removing this Mac is signing out; any other device of the account is cut off within seconds. */
  async removeDevice(id: string): Promise<CloudAccount> {
    if (this.#stored?.device.id === id) return this.signOut()
    await this.#call("devices.remove", "DELETE", `/v1/devices/${encodeURIComponent(id)}`)
    return this.account()
  }

  /**
   * Signs this Mac out: here at once, and in the cloud, which removes the device so its credential works nowhere. One
   * the cloud didn't hear (unreachable, or failing) is kept sealed as unfinished and asked again until the cloud has
   * removed the device, so a sign-out never leaves a working credential behind.
   */
  async signOut(): Promise<CloudAccount> {
    await this.#ready
    const stored = this.#stored
    let unfinished: UnfinishedSignOut | undefined
    if (stored) {
      // Said first, so the account's other devices stop waiting on this one at once, whether or not the removal lands.
      this.#goingQuiet("sign-out")
      try {
        await this.#call("devices.remove", "DELETE", `/v1/devices/${encodeURIComponent(stored.device.id)}`, undefined, false, [401, 404])
      } catch (error) {
        this.#options.log?.("cloud sign-out didn't reach the cloud; it's finished later", { error: errorMessage({ error }) })
        unfinished = { version: 1, cloud: stored.cloud, credential: stored.credential, device: stored.device.id }
        await this.#keepUnfinished(unfinished)
      }
    }
    await this.#forget()
    if (unfinished) {
      this.#set({ status: "signed-out", finishing: true })
      this.#finishSignOutSoon(0)
    }
    return this.account()
  }

  async #keepUnfinished(unfinished: UnfinishedSignOut): Promise<void> {
    const { secrets, secretName } = this.#options
    if (await secrets.durable()) await secrets.write("mako-sign-in", `${secretName}.signing-out`, JSON.stringify(unfinished))
    else this.#unfinished = unfinished
  }

  /** Asks the cloud again to remove a device this Mac signed out of, after `ms`; once at a time. */
  #finishSignOutSoon(ms = SIGN_OUT_RETRY_MS): void {
    if (this.#closed || this.#finishing) return
    this.#finishing = setTimeout(() => {
      this.#finishing = undefined
      void this.#finishSignOut()
    }, ms)
    this.#finishing.unref()
  }

  /**
   * The unfinished sign-out, finished: the credential buys a token and the device is removed with it. A credential the
   * cloud no longer takes, or a device it no longer has, means it's done already. Anything else is asked again.
   */
  async #finishSignOut(): Promise<void> {
    const { secrets, secretName } = this.#options
    const record = this.#unfinished ?? (await secrets.read("mako-sign-in", `${secretName}.signing-out`).then((found) => (found ? UnfinishedSignOutSchema.parse(JSON.parse(found.value)) : undefined), () => undefined))
    if (!record || this.#closed) return
    const cloud = this.#cloud
    if (!cloud || record.cloud !== cloud.origin) return
    const done = async () => {
      this.#unfinished = undefined
      await secrets.delete("mako-sign-in", `${secretName}.signing-out`).catch(() => undefined)
      this.#options.log?.("cloud sign-out finished: the device is removed", { device: record.device })
      if (this.#state.status === "signed-out" && this.#state.finishing) this.#set({ status: "signed-out" })
    }
    try {
      const refreshed = await this.#fetch("devices.token", new URL("/v1/devices/token", cloud), {
        method: "POST",
        headers: { authorization: `Bearer ${record.credential}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_MS),
      })
      if (refreshed.status === 401) return await done()
      if (!refreshed.ok) throw new CloudAccountError(await problemOf(refreshed, "The Mako cloud didn't answer."))
      const { connection } = RefreshSchema.parse(await refreshed.json())
      const removed = await this.#fetch("devices.remove", new URL(`/v1/devices/${encodeURIComponent(record.device)}`, cloud), {
        method: "DELETE",
        headers: { authorization: `Bearer ${connection.token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_MS),
      })
      if (removed.ok || removed.status === 401 || removed.status === 404) return await done()
      throw new CloudAccountError(await problemOf(removed, "The Mako cloud didn't answer."))
    } catch (error) {
      this.#options.log?.("cloud sign-out still unfinished; asking again", { error: errorMessage({ error }) })
      if (this.#state.status === "signed-out" && !this.#state.finishing && !this.#state.notice) this.#set({ status: "signed-out", finishing: true })
      this.#finishSignOutSoon()
    }
  }

  /** After sleep or a network change: reconnect now rather than at the next backoff step. */
  wake(): void {
    if (this.#state.status === "signed-out" && this.#state.finishing && this.#finishing) {
      clearTimeout(this.#finishing)
      this.#finishing = undefined
      this.#finishSignOutSoon(0)
    }
    if (this.#state.status !== "signed-in" || this.#closed) return
    const stale = this.#pool
    this.#pool = new Agent()
    void stale.destroy().catch(() => undefined)
    this.#accountLink?.wake()
    this.#runtimeLink?.wake()
    for (const session of this.#sessions) session.wake()
  }

  /**
   * This Mac is going to sleep, or shutting down: its runtime says so to the cloud while it still can, so the account's
   * other devices take it as quiet at once (`going-quiet`), and its link stays closed until the wake. A gateway too old
   * for the frame sees the link close cleanly, and the device goes quiet after the usual wait.
   */
  leaving(why: "sleep" | "quit"): void {
    if (this.#state.status !== "signed-in" || this.#closed) return
    this.#goingQuiet(why)
    this.#runtimeLink?.quiet()
  }

  close(): void {
    this.#goingQuiet("quit")
    this.#closed = true
    if (this.#seenSave) {
      clearTimeout(this.#seenSave)
      this.#seenSave = undefined
      this.#saveSeen()
    }
    if (this.#finishing) clearTimeout(this.#finishing)
    if (this.#signIn) this.#endSignIn()
    this.#disconnect()
    void this.#pool.close().catch(() => undefined)
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
    this.#seen = undefined
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
    // A sign-out the cloud hadn't heard of when Mako last ran is finished first, whatever else this Mac does.
    void this.#finishSignOut()
    const stored = await this.#load().catch((error) => {
      this.#options.log?.("cloud sign-in couldn't be read back", { error: messageOf(error, "unknown") })
      return undefined
    })
    if (!stored || this.#closed) return
    this.#stored = stored
    this.#seen = stored.seen
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

  /**
   * False when the keychain is unavailable: the credential then lives in memory, until Mako quits. Written after any
   * write before it, with the last account event heard.
   */
  #save(stored: Stored): Promise<boolean> {
    const { secrets, secretName } = this.#options
    const write = this.#writes.then(async () => {
      if (!(await secrets.durable())) return false
      const seen = this.#seen
      await secrets.write("mako-sign-in", secretName, JSON.stringify(seen === undefined ? stored : { ...stored, seen }))
      return true
    })
    this.#writes = write.catch(() => undefined)
    return write
  }

  /** Keeps the last account event heard soon, with every other heard meanwhile (`SEEN_SAVE_MS`). */
  #rememberSeen(): void {
    if (this.#seenSave) return
    this.#seenSave = setTimeout(() => {
      this.#seenSave = undefined
      // A token refresh in flight may be keeping a new credential: this waits for it, rather than write the old one after.
      if (this.#tokenRequest) return this.#rememberSeen()
      this.#saveSeen()
    }, SEEN_SAVE_MS)
    this.#seenSave.unref?.()
  }

  #saveSeen(): void {
    const stored = this.#stored
    if (!stored || this.#seen === undefined) return
    void this.#save(stored).catch((error: Error) => this.#options.log?.("cloud account event not remembered as heard", { error: error.message }))
  }

  async #forget(notice?: CloudSignedOutNotice): Promise<void> {
    this.#stored = undefined
    this.#seen = undefined
    clearTimeout(this.#seenSave)
    this.#seenSave = undefined
    this.#token = undefined
    this.#disconnect()
    // A write already begun lands first, so the sign-in it writes is removed after it, never brought back.
    await this.#writes
    await this.#options.secrets.delete("mako-sign-in", this.#options.secretName)
    this.#set(notice ? { status: "signed-out", notice } : { status: "signed-out" })
  }

  /** The credential stopped working: removed from this account, here or on another device, or seen used elsewhere. */
  async #removed(notice: CloudSignedOutNotice = REMOVED): Promise<void> {
    if (!this.#stored) return
    this.#options.log?.("cloud device removed", { device: this.#stored.device.id, kind: notice.kind })
    await this.#forget(notice)
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
      async (endpoint) => new WebSocket(new URL(endpointPath(endpoint), cloud), subprotocols(await this.#connectionToken())),
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
      const reused = /used somewhere else/.test(await problemOf(response, ""))
      await this.#removed(reused ? REUSED : REMOVED)
      throw new Removed()
    }
    if (!response.ok) throw new CloudAccountError(await problemOf(response, "The Mako cloud didn't answer."))
    const refreshed = RefreshSchema.parse(await response.json())
    if (this.#stored !== stored) throw new Removed()
    this.#token = hold(refreshed.connection)
    let next: Stored = { ...stored, account: refreshed.account, device: refreshed.device }
    if (refreshed.credential) {
      // The successor is kept before it's used, so a restart never brings back a credential the cloud retired. One
      // that can't be kept is left: the old credential works until the successor's first use, and the next refresh
      // offers another. Without a keychain both live in memory alone, and the successor is used at once.
      const rotated = { ...next, credential: refreshed.credential }
      try {
        await this.#save(rotated)
        next = rotated
      } catch (error) {
        this.#options.log?.("cloud credential successor not kept; the current one stays", { error: errorMessage({ error }) })
      }
    }
    if (this.#stored !== stored) throw new Removed()
    this.#stored = next
    if (this.#state.status === "signed-in" && (!sameJson(this.#state.account, refreshed.account) || !sameJson(this.#state.device, refreshed.device)))
      this.#set({ ...this.#state, account: refreshed.account, device: refreshed.device })
    // An upgrade, or its end, reaches this Mac with its next token: the runtime's link follows it.
    this.#syncRuntime()
    return refreshed.connection.token
  }

  /** A call as this Mac; a status in `answers` is an answer to read, not a refusal. */
  async #call(route: CloudRoute, method: CloudRequest["method"], path: string, body?: JsonValue | FileBody, retried = false, answers: number[] = []): Promise<CloudResponse> {
    const token = await this.#connectionToken().catch((error) => {
      throw error instanceof Removed ? new CloudAccountError("This Mac isn't signed in to Mako.") : error
    })
    const init: CloudRequest = {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
    }
    if (body instanceof FileBody) {
      // Bytes, such as a move's checkpoint: streamed with their length, given as long as their size needs.
      init.headers["content-type"] = "application/octet-stream"
      init.headers["content-length"] = String(body.bytes)
      init.body = body.sent ? Readable.from(countedFile(body.file, body.sent)) : createReadStream(body.file)
      init.duplex = "half"
      init.signal = AbortSignal.timeout(REQUEST_MS + Math.ceil(body.bytes / UPLOAD_BYTES_PER_MS))
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json"
      init.body = JSON.stringify(body)
    }
    const response = await this.#fetch(route, new URL(path, this.#require()), init)
    // The token can lapse between being handed out and arriving; one fresh one settles it.
    if (response.status === 401 && !retried) {
      if (this.#token?.token === token) this.#token = undefined
      return this.#call(route, method, path, body, true, answers)
    }
    if (!response.ok && !answers.includes(response.status)) throw new CloudAccountError(await problemOf(response, "The Mako cloud refused that."))
    return response
  }

  /** Every call to the cloud: sent under a fresh correlation ID, and reported when it ends. */
  async #fetch(route: CloudRoute, url: URL, init: CloudRequest): Promise<CloudResponse> {
    const correlationId = randomUUID()
    const started = performance.now()
    const report = (outcome: DiagnosticEvents["cloud.request"]["outcome"], status: number | undefined, how: { error?: string; reached: string }) => {
      const ms = Math.round(performance.now() - started)
      this.#options.onRequest?.({ route, outcome, ...(status !== undefined && { status }), ms, correlationId })
      // A slow answer is said too: after a wake, how long the cloud took is what tells a stalled network apart.
      if (outcome !== "ok" || ms >= SLOW_REQUEST_MS) this.#options.log?.("cloud request", { route, outcome, ...(status !== undefined && { status }), ms, ...how, correlationId })
    }
    const trace = this.#traces.follow(correlationId)
    let response: CloudResponse
    try {
      response = await fetchWith(url, { ...init, headers: { ...init.headers, [CORRELATION_HEADER]: correlationId }, dispatcher: this.#pool })
    } catch (error) {
      // How far it got: whether it ever left this Mac, and on which connection, which the cloud's log can't say.
      report("unreachable", undefined, { error: errorMessage({ error }), reached: trace.describe() })
      if (error instanceof Error && error.name === "TimeoutError") throw new CloudAccountError(`The Mako cloud didn't answer within ${Math.round((performance.now() - started) / 1000)} seconds.`)
      throw error
    } finally {
      trace.end()
    }
    report(response.ok ? "ok" : response.status < 500 ? "refused" : "failed", response.status, { reached: trace.describe() })
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

  /**
   * The account's connection: its token renewed in place, the cloud's word when it ends it, and the account's stream
   * followed from the last event this device heard, so what happened while it was off is heard now.
   */
  #attachAccount(socket: WebSocket, end: (ending: CloudLinkEnding) => void): CloudLinkAttachment {
    const renewing = renewal(this.#credential(), (token) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeClientFrame({ type: "renew", token }))
    })
    const following = this.#stored
    if (following && socket.readyState === WebSocket.OPEN)
      socket.send(encodeClientFrame({ type: "subscribe", stream: accountStream(following.account.id), after: this.#seen ?? 0 }))
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
      else if (frame.type === "event") this.#heard(frame.event)
    })
    return { close: () => renewing.stop() }
  }

  /**
   * One event of the account's stream: told once, in order, as it's heard, with nothing awaited before it, so the next
   * can't overtake it; then remembered as heard, soon (`SEEN_SAVE_MS`).
   */
  #heard(frame: EventFrame): void {
    const stored = this.#stored
    if (!stored || frame.stream !== accountStream(stored.account.id) || frame.seq <= (this.#seen ?? 0)) return
    const before = this.#seen
    this.#seen = frame.seq
    this.#rememberSeen()
    if (before !== undefined && frame.seq > before + 1) this.#options.onAccountGap?.({ after: before, seq: frame.seq, why: "skipped" })
    const decoded = frame.event.decode()
    const parsed = AccountEventSchema.safeParse(decoded)
    // A kind of event this build doesn't know is passed over, never refused; one the gateway lost is a gap.
    if (!parsed.success) {
      if (LostEventSchema.safeParse(decoded).success) this.#options.onAccountGap?.({ after: frame.seq - 1, seq: frame.seq, why: "lost" })
      return
    }
    const event = parsed.data
    const mine = event.type === "device-joined" ? event.device.id === stored.device.id : event.type === "device-removed" ? event.deviceId === stored.device.id : false
    if (event.type === "device-joined" && Date.parse(frame.at) < Date.parse(stored.device.createdAt)) return
    this.#options.onAccountEvent?.({ seq: frame.seq, at: frame.at, event, mine })
  }

  /** This Mac's runtime: the host served to the cloud, claiming again the Threads it ran when the link last ended. */
  #attachRuntime(runtimeId: string, socket: WebSocket, end: (ending: CloudLinkEnding) => void): CloudLinkAttachment {
    const runtime = this.#options.runtime
    const link = runtimeLinkOverSocket(socket)
    let served: ServedRuntime | undefined
    let closed = false
    if (runtime)
      runtime.serve(link, { runtimeId, credential: this.#credential(), threads: this.#claims, watch: (conversations, after) => this.#options.sessions?.watch(link, conversations, after) }).then(
        (started) => {
          served = started
          if (closed) return started.close()
          this.#served = { link, served: started }
          this.#options.sessions?.linked(this.#served)
          this.#options.log?.("cloud runtime enrolled", { runtimeId, claims: this.#claims.length })
          void started.ended.then((problem) => {
            this.#claims = started.claims()
            if (this.#served?.served === started) this.#served = undefined
            end(endingOf(problem))
          })
        },
        (error) => end(error instanceof RuntimeRefusedError ? endingOf(error.problem) : "lost")
      )
    return {
      close: () => {
        closed = true
        if (served) this.#claims = served.claims()
        if (served && this.#served?.served === served) this.#served = undefined
        link.close()
      },
    }
  }

  /** Tells the cloud this runtime is going away on purpose, on a link that knows the frame. */
  #goingQuiet(reason: GoingQuietReason): void {
    const served = this.#served?.served
    if (!served || this.#closed) return
    if (served.goingQuiet(reason)) this.#options.log?.("cloud runtime going quiet", { reason })
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

  /** The cloud's address, when this build has one; nothing is fetched to say so. */
  gateway(): URL | undefined {
    return this.#cloud ? new URL(this.#cloud) : undefined
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

async function problemOf(response: CloudResponse, fallback: string): Promise<string> {
  return problemWords(ProblemSchema.safeParse(await response.json().catch(() => undefined)).data, fallback)
}

/** A problem document's words; `fallback` when the body wasn't one. */
function problemWords(problem: z.infer<typeof ProblemSchema> | undefined, fallback: string): string {
  const title = problem?.title
  return title ? (problem.detail ? `${title}. ${problem.detail}` : title) : fallback
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
