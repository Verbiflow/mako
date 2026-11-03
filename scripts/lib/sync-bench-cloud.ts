import { randomUUID, createHash } from "node:crypto"
import { once } from "node:events"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { z } from "zod"
import {
  PING,
  PONG,
  PROTOCOL_VERSION,
  Payload,
  SUBPROTOCOL,
  declaredLiveForm,
  decodeClientFrame,
  decodeRuntimeFrame,
  encodeGatewayClientFrame,
  encodeGatewayFrame,
  offeredCredential,
  type Actor,
  type LiveForm,
  type Subscription,
} from "@mako/protocol"
import { accountStream, type AccountEvent } from "@mako/protocol/account-events"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { mayReplace, sameListed, type ListedSession, type SessionListings } from "@mako/protocol/thread-listing"
import type { JsonValue } from "@mako/host/contracts/json"
import type { WebConnection } from "../../src/web-client/gateway.ts"

/**
 * The cloud `npm run bench:sync-latency` runs its devices against: the protocol's fake gateway served over HTTP and
 * WebSockets in this process, or any gateway at a URL with a helper that plays the person there. Either way the bench
 * asks it the same few things, and times only what the devices do.
 */
export interface BenchCloud {
  /** Where every device reaches it (each through a link of its own the bench can stall or cut). */
  readonly url: string
  /** What it is, for the report: `fake`, or the gateway's origin. */
  readonly name: string
  /** Whether it runs on this computer, so the local budgets apply rather than a network's. */
  readonly local: boolean
  /** Whether it says when a device goes quiet: the fake gateway keeps no presence, so the quiet phase needs a real one. */
  readonly presence: boolean
  /** An account with the cloud, made before any device signs in, so every token carries the entitlement from the start. */
  account(): Promise<{ email: string }>
  /** Plays the person on the sign-in page a host opened, choosing the account. */
  signIn(url: string): Promise<void>
  /** A browser's connection, as the web client trades its sign-in for one: asked again before each runs out. */
  phone(): Promise<WebConnection>
  /** A cloud Thread with a machine assigned, for an in-process machine runtime to link as; undefined to skip that hop. */
  cloudThread(): Promise<CloudThreadPlace | undefined>
  close(): Promise<void>
}

/** A cloud Thread, what its machine's runtime links with (`machine-agent.ts`'s `link`), and where its watchers subscribe. */
export const CloudThreadPlaceSchema = z.object({
  threadId: z.string(),
  runtimeId: z.string(),
  gatewayUrl: z.string(),
  credential: z.string(),
  machine: z.string(),
  generation: z.number().int().positive(),
  /** A WebSocket URL a client subscribes to the Thread's stream on. */
  watch: z.string(),
})
export type CloudThreadPlace = z.infer<typeof CloudThreadPlaceSchema>

const WebConnectionSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
  deviceId: z.string(),
  account: z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable(), entitlements: z.array(z.string()) }),
})

/**
 * A gateway at a URL, with a helper on the other end of this process's stdin and stdout playing the person there: the
 * bench writes `ASK <json>` lines and reads one JSON line back for each, in order. What a helper answers:
 *
 *   {"ask":"account"}        → {"email": "…"}   an account with the cloud, made for this run
 *   {"ask":"sign-in","url"}  → {}               the host's sign-in page, completed as the person
 *   {"ask":"phone"}          → a WebConnection  a browser of the account's connection token
 *   {"ask":"cloud-thread"}   → a CloudThreadPlace, or {"skip": "why"}
 */
type Question = { ask: "account" } | { ask: "sign-in"; url: string } | { ask: "phone" } | { ask: "cloud-thread" }

export function helperCloud(url: string, presence: boolean): BenchCloud {
  const origin = new URL(url)
  const lines = createInterface({ input: process.stdin })
  const waiting: Array<(line: string) => void> = []
  lines.on("line", (line) => waiting.shift()?.(line))
  let queue = Promise.resolve<unknown>(undefined)
  const ask = <T>(question: Question, schema: z.ZodType<T>): Promise<T> => {
    const asked = queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          waiting.push((line) => {
            const parsed = schema.safeParse(JSON.parse(line))
            if (parsed.success) resolve(parsed.data)
            else reject(new Error(`the helper answered ${question.ask} with ${line.slice(0, 200)}`))
          })
          process.stdout.write(`ASK ${JSON.stringify(question)}\n`)
        })
    )
    queue = asked.catch(() => undefined)
    return asked
  }
  return {
    url: origin.origin,
    name: origin.origin,
    local: ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
    presence,
    account: () => ask({ ask: "account" }, z.object({ email: z.string() })),
    signIn: async (page) => void (await ask({ ask: "sign-in", url: page }, z.object({}).loose())),
    phone: () => ask({ ask: "phone" }, WebConnectionSchema),
    cloudThread: async () => {
      const answer = await ask({ ask: "cloud-thread" }, z.union([CloudThreadPlaceSchema, z.object({ skip: z.string() })]))
      return "skip" in answer ? undefined : answer
    },
    close: async () => lines.close(),
  }
}

type Device = { id: string; kind: "desktop" | "browser"; name: string; platform: string; appVersion: string | null; credential: string; createdAt: string }

const MACHINE = "m-0123456789abcdef"
const TOKEN_SECONDS = 300

/**
 * The protocol's fake gateway (`createFakeGateway`) behind the routes a host and a browser use: the sign-in hand-off
 * and token renewal, the account's stream and list, each runtime's link, clients calling a runtime or following one of
 * its conversations, and a cloud Thread's stream. The account's list is kept as a gateway keeps it: each runtime's
 * `sessions` report replaces the rows it may (`mayReplace`), and a row that changes as a list shows it (`sameListed`) is
 * said on the account's stream at once. It decides no presence, so a quiet device is never said.
 */
export async function fakeCloud(): Promise<BenchCloud> {
  const gateway = createFakeGateway({ renew: () => Math.floor(Date.now() / 1000) + TOKEN_SECONDS })
  const account = { id: randomUUID(), name: "Sync Bench", email: "sync-bench@example.com", image: null, entitlements: ["cloud"] }
  const devices = new Map<string, Device>()
  const codes = new Map<string, { challenge: string; name: string; platform: string; appVersion: string | null }>()
  const rows = new Map<string, ListedSession>()
  const events: Array<{ seq: number; at: string; text: string }> = []
  const following = new Set<ServerSocket>()
  const sockets = new Set<ServerSocket>()
  const threadWatch = new Set<string>()

  const token = (deviceId: string) => {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_SECONDS
    const body = Buffer.from(JSON.stringify({ sub: account.id, did: deviceId, exp })).toString("base64url")
    return { token: `eyJhbGciOiJub25lIn0.${body}.bench`, expiresAt: exp }
  }
  const verify = (value: string | undefined): Device | undefined => {
    if (!value) return undefined
    const claims = z.object({ did: z.string(), exp: z.number() }).safeParse(JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString() || "null")).data
    return claims && claims.exp > Date.now() / 1000 ? devices.get(claims.did) : undefined
  }
  const publicDevice = ({ credential: _credential, ...device }: Device) => ({ ...device, enrolledBy: "browser" as const, lastSeenAt: new Date().toISOString() })
  const device = (kind: Device["kind"], name: string, platform: string, appVersion: string | null): Device => {
    const made: Device = { id: randomUUID(), kind, name, platform, appVersion, credential: `mako_dc_${createHash("sha256").update(randomUUID()).digest("base64url")}`, createdAt: new Date().toISOString() }
    devices.set(made.id, made)
    return made
  }

  const eventFrame = (event: { seq: number; at: string; text: string }) =>
    encodeGatewayClientFrame({ type: "event", event: { v: PROTOCOL_VERSION, stream: accountStream(account.id), seq: event.seq, at: event.at, event: Payload.encoded(event.text) } })
  const say = (event: AccountEvent) => {
    const said = { seq: events.length + 1, at: new Date().toISOString(), text: JSON.stringify(event) }
    events.push(said)
    for (const socket of following) if (socket.readyState === socket.OPEN) socket.send(eventFrame(said))
  }
  /** A runtime's report of its Sessions, taken as the account takes one: each row it may replace, said if a list would show it. */
  const report = (runtimeId: string, text: string) => {
    if (!text.includes('"sessions"')) return
    let frame
    try {
      frame = decodeRuntimeFrame(text)
    } catch {
      // Not a frame at all: the fake gateway refuses it on the link itself.
      return
    }
    if (frame.type !== "sessions") return
    const deviceId = /^d-(.+)$/.exec(runtimeId)?.[1]
    if (!deviceId) return
    const runsOn = { kind: "device" as const, deviceId }
    const listed: ListedSession[] = []
    const unlisted: string[] = []
    const listedAt = new Date().toISOString()
    for (const row of frame.report.listed) {
      const next: ListedSession = { ...row, runsOn, listedAt }
      const held = rows.get(row.session)
      if (!mayReplace(held, { generation: row.generation, runsOn })) continue
      rows.set(row.session, next)
      if (!sameListed(held, next)) listed.push(next)
    }
    const owned = frame.report.owned && new Set(frame.report.owned.map((entry) => entry.session))
    for (const [session, row] of rows) {
      const gone = frame.report.gone.some((entry) => entry.session === session) || (owned && !owned.has(session))
      if (gone && row.runsOn.kind === "device" && row.runsOn.deviceId === deviceId) {
        rows.delete(session)
        unlisted.push(session)
      }
    }
    if (listed.length) say({ type: "sessions-listed", sessions: listed })
    if (unlisted.length) say({ type: "sessions-unlisted", sessions: unlisted })
  }

  const json = async (request: IncomingMessage) => {
    let text = ""
    for await (const chunk of request) text += chunk
    return text ? JSON.parse(text) : {}
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://cloud")
    const send = (status: number, body?: JsonValue) => response.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body))
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1]
    if (request.method === "POST" && url.pathname === "/v1/devices/enroll") {
      const { code, codeVerifier } = z.object({ code: z.string(), codeVerifier: z.string() }).parse(await json(request))
      const grant = codes.get(code)
      codes.delete(code)
      if (!grant || createHash("sha256").update(codeVerifier).digest("base64url") !== grant.challenge) return send(400, { title: "That sign-in code isn't valid" })
      const made = device("desktop", grant.name, grant.platform, grant.appVersion)
      return send(201, { device: publicDevice(made), credential: made.credential, connection: token(made.id), account })
    }
    if (request.method === "POST" && url.pathname === "/v1/devices/token") {
      const known = [...devices.values()].find((entry) => entry.credential === bearer)
      if (!known) return send(401, { title: "This device was removed" })
      return send(200, { device: publicDevice(known), connection: token(known.id), account })
    }
    const caller = verify(bearer)
    if (!caller) return send(401, { title: "The connection token isn't valid here" })
    if (request.method === "GET" && url.pathname === "/v1/sessions") return send(200, { sessions: [...rows.values()], seq: events.length, quiet: [] } satisfies SessionListings)
    if (request.method === "GET" && url.pathname === "/v1/devices") return send(200, { devices: [...devices.values()].map(publicDevice), current: caller.id })
    if (request.method === "GET" && url.pathname === `/v1/accounts/${account.id}/sign-ins`) return send(200, { signIns: [], kept: [] })
    if (request.method === "DELETE" && url.pathname === `/v1/devices/${caller.id}`) {
      devices.delete(caller.id)
      return send(204)
    }
    send(404, { title: "Not found" })
  })

  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) })
  server.on("upgrade", (request, socket, head) => {
    const asked = new URL(request.url ?? "/", "http://cloud")
    const path = asked.pathname
    const credential = offeredCredential(request.headers["sec-websocket-protocol"])
    const caller = verify(credential)
    const runtime = /^\/v1\/runtimes\/([\w.-]+)\/connect$/.exec(path)?.[1]
    const calling = /^\/v1\/runtimes\/([\w.-]+)\/clients$/.test(path)
    const thread = /^\/v1\/threads\/([\w.-]+)\/connect$/.exec(path)?.[1]
    // A device's runtime is its own; a machine's is the one the bench's Thread was given; a Thread's watchers need no sign-in here.
    const allowed =
      (runtime?.startsWith("d-") && caller?.id === runtime.slice(2)) ||
      (runtime?.startsWith(`${MACHINE}.`) && credential?.startsWith("mmc_")) ||
      ((calling || path === `/v1/accounts/${account.id}/connect`) && caller) ||
      (thread && threadWatch.has(thread))
    if (!allowed) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws)
      ws.on("close", () => sockets.delete(ws))
      if (runtime) return bridgeRuntime(ws, runtime)
      const actor: Actor = { kind: "client", client: caller?.kind === "browser" ? "web" : "desktop", deviceId: caller?.id ?? randomUUID() }
      if (calling || thread) return bridgeClient(ws, actor, declaredLiveForm(asked))
      followAccount(ws)
    })
  })

  /** The account's connection: its stream followed after a number, its token renewed in place. */
  const followAccount = (ws: ServerSocket) => {
    ws.on("close", () => following.delete(ws))
    ws.on("message", (data) => {
      const text = String(data)
      if (text === PING) return ws.send(PONG)
      const frame = decodeClientFrame(text)
      if (frame.type === "subscribe") {
        following.add(ws)
        for (const event of events.filter((entry) => entry.seq > frame.after)) ws.send(eventFrame(event))
      } else if (frame.type === "renew") ws.send(encodeGatewayClientFrame({ type: "renewed", expiresAt: token("").expiresAt }))
    })
  }
  /** A runtime's link, carried to the fake gateway frame by frame; its reports also make the account's list. */
  const bridgeRuntime = (ws: ServerSocket, runtimeId: string) => {
    void gateway.connectRuntime().then((link) => {
      ws.on("message", (data) => {
        const text = String(data)
        if (text === PING) return ws.send(PONG)
        report(runtimeId, text)
        link.sendUnchecked(text)
      })
      ws.on("close", () => link.close())
      void (async () => {
        for await (const frame of link.frames()) if (ws.readyState === ws.OPEN) ws.send(encodeGatewayFrame(frame))
        if (ws.readyState === ws.OPEN) ws.close(1000)
      })()
    })
  }
  /** A client's connection to a runtime or a Thread: its calls answered, its subscriptions followed, its token renewed. */
  const bridgeClient = (ws: ServerSocket, actor: Actor, live: LiveForm) => {
    const session = gateway.connectClient(actor, { live })
    const subscriptions = new Map<string, Subscription>()
    ws.on("close", () => {
      for (const subscription of subscriptions.values()) subscription.close()
    })
    ws.on("message", async (data) => {
      const text = String(data)
      if (text === PING) return ws.send(PONG)
      const frame = decodeClientFrame(text)
      const client = await session
      if (frame.type === "renew") ws.send(encodeGatewayClientFrame({ type: "renewed", expiresAt: token("").expiresAt }))
      else if (frame.type === "call") {
        const reply = await client.call(frame.operation)
        if (ws.readyState === ws.OPEN) ws.send(encodeGatewayClientFrame({ type: "reply", reply }))
      } else if (frame.type === "subscribe") {
        subscriptions.get(frame.stream)?.close()
        const subscription = client.subscribe({ stream: frame.stream, after: frame.after })
        subscriptions.set(frame.stream, subscription)
        void (async () => {
          for (;;) {
            const event = await subscription.next().catch(() => undefined)
            if (!event) return
            if (ws.readyState === ws.OPEN) ws.send(encodeGatewayClientFrame({ type: "event", event }))
          }
        })()
      } else if (frame.type === "unsubscribe") {
        subscriptions.get(frame.stream)?.close()
        subscriptions.delete(frame.stream)
      }
    })
  }

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  // SAFETY: listening on a TCP host and port, so the address is an AddressInfo.
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    name: "fake",
    local: true,
    presence: false,
    account: async () => ({ email: account.email }),
    async signIn(page) {
      const asked = new URL(page)
      const code = `code-${randomUUID()}`
      codes.set(code, { challenge: asked.searchParams.get("code_challenge") ?? "", name: asked.searchParams.get("device_name") ?? "Mac", platform: asked.searchParams.get("platform") ?? "macOS", appVersion: asked.searchParams.get("app_version") })
      const callback = new URL(asked.searchParams.get("redirect_uri") ?? "")
      callback.searchParams.set("code", code)
      callback.searchParams.set("state", asked.searchParams.get("state") ?? "")
      const answered = await fetch(callback, { redirect: "manual" })
      if (answered.status >= 400) throw new Error(`the host's sign-in refused its code: ${answered.status}`)
    },
    async phone() {
      const browser = [...devices.values()].find((entry) => entry.kind === "browser") ?? device("browser", "Phone", "iOS", null)
      const { token: value, expiresAt } = token(browser.id)
      return { token: value, expiresAt: expiresAt * 1000, deviceId: browser.id, account }
    },
    async cloudThread() {
      const threadId = `t-${randomUUID().replaceAll("-", "").slice(0, 16)}`
      const runtimeId = `${MACHINE}.g1`
      threadWatch.add(threadId)
      await gateway.assign(threadId, runtimeId)
      return { threadId, runtimeId, gatewayUrl: url, credential: `mmc_${"k".repeat(43)}`, machine: MACHINE, generation: 1, watch: `${url.replace(/^http/, "ws")}/v1/threads/${threadId}/connect` }
    },
    async close() {
      for (const socket of sockets) socket.terminate()
      wss.close()
      server.closeAllConnections()
      server.close()
      await gateway.close()
    },
  }
}
