/**
 * The desktop's Mako account against a fake cloud that speaks the gateway's
 * protocol: the loopback hand-off with PKCE, the encrypted credential, token
 * renewal over the open socket, reconnecting without a person ever seeing a
 * blip, being removed elsewhere, and, with the cloud entitlement, this Mac
 * served to the cloud as its runtime.
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { connect, createServer as createTcpServer, type Socket } from "node:net"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { z } from "zod"
import {
  PING,
  PONG,
  PROTOCOL_VERSION,
  Payload,
  type RuntimeFrame,
  SUBPROTOCOL,
  decodeClientFrame,
  decodeRuntimeFrame,
  encodeGatewayClientFrame,
  encodeGatewayFrame,
  offeredCredential,
  problem,
  serveRuntime,
} from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { CloudAccounts, type CloudAccountOptions, type CloudRuntime } from "@mako/host/usage/cloud-account"
import { declareCloudAccountMethods } from "@mako/host/usage/cloud-account-methods"
import { HostMethods } from "@mako/host/transport/methods"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { CloudSignInSync } from "@mako/host/harnesses/cloud-sign-ins"
import { HarnessAccounts } from "@mako/host/harnesses/accounts"
import { ProviderRegistry } from "@mako/host/harnesses/registry"
import type { ProviderAccountCapability } from "@mako/host/harnesses/account-capability"
import type { Machine } from "@mako/host/base/machine"
import type { CloudSignInsState } from "@mako/host/contracts/cloud-sign-ins"
import type { CloudAccount, CloudAccountState, CloudDevice } from "@mako/host/contracts/cloud-account"
import type { DiagnosticEvents } from "@mako/host/contracts/telemetry"
import { aesSealer, fileSecrets, wrappedKey } from "@mako/host/base/secrets"
import type { SecretEncryption } from "@mako/host/base/secure-storage"

const scratch = await mkdtemp(join(tmpdir(), "mako-cloud-account-"))
after(() => rm(scratch, { recursive: true, force: true }))

/** Reversible and recognisable, so the test can tell the file holds no credential in the clear. */
const encryption: SecretEncryption = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64").split("").reverse().join("")}`),
  decrypt: async (value) => Buffer.from(value.toString().slice("sealed:".length).split("").reverse().join(""), "base64").toString(),
}
const noKeychain: SecretEncryption = { ...encryption, available: async () => false }
/** The host's store, under the stand-in keychain; each test's Mac keeps its sign-in under its own name. */
const vault = join(scratch, "secrets")
const secrets = (keychain = encryption) => fileSecrets(vault, aesSealer(wrappedKey(join(vault, "data-key"), keychain)))
const recordPath = (name: string) => join(vault, "mako-sign-in", ...`${name}.json`.split("/"))

type FakeDevice = CloudDevice & { credential: string; removed: boolean }

/** The gateway's identity API, in memory. */
async function fakeCloud() {
  const codes = new Map<string, { challenge: string; device: Pick<CloudDevice, "name" | "platform" | "appVersion"> }>()
  const devices = new Map<string, FakeDevice>()
  /** Every live socket: whose device, and whether it's the account's connection or the device's runtime's link. */
  const sockets = new Map<ServerSocket, { device: string; kind: "account" | "runtime" | "client" }>()
  const calls: string[] = []
  const correlations: (string | string[] | undefined)[] = []
  /** What each ask to make a Thread sent. */
  const threads: Array<{ threadId: string; prepare?: boolean }> = []
  /** Repositories asked for project bases. */
  const bases: unknown[] = []
  const options = { tokenSeconds: 300, clockSkewSeconds: 0, refuseTokens: false, failRefreshes: 0 }
  const account = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null, entitlements: ["cloud"] }
  /** The gateway a runtime's link reaches: the protocol's fake, which answers renewals with the same check. */
  const gateway = createFakeGateway({ renew: (value) => (verify(value) ? Math.floor(Date.now() / 1000) + options.tokenSeconds : undefined) })
  const enrolments: Extract<RuntimeFrame, { type: "enroll" }>[] = []
  const token = (deviceId: string) => {
    const iat = Math.floor(Date.now() / 1000) + options.clockSkewSeconds
    const exp = iat + options.tokenSeconds
    const body = Buffer.from(JSON.stringify({ sub: account.id, did: deviceId, iat, exp })).toString("base64url")
    return { token: `eyJhbGciOiJFZERTQSJ9.${body}.signature`, expiresAt: exp }
  }
  const verify = (value: string | undefined) => {
    const claims = value && JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString())
    const device = claims && devices.get(claims.did)
    return device && !device.removed && !options.refuseTokens ? device : undefined
  }
  const publicDevice = ({ credential: _credential, removed: _removed, ...device }: FakeDevice): CloudDevice => device
  const json = async (request: IncomingMessage) => {
    let text = ""
    for await (const chunk of request) text += chunk
    return JSON.parse(text)
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://cloud")
    calls.push(`${request.method} ${url.pathname}`)
    correlations.push(request.headers["x-mako-correlation-id"])
    const send = (status: number, body?: string) => {
      response.writeHead(status, { "content-type": "application/json" }).end(body)
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1]
    if (request.method === "POST" && url.pathname === "/v1/devices/enroll") {
      const { code, codeVerifier } = await json(request)
      const grant = codes.get(code)
      codes.delete(code)
      if (!grant || createHash("sha256").update(codeVerifier).digest("base64url") !== grant.challenge)
        return send(400, JSON.stringify({ title: "That sign-in code isn't valid" }))
      const device: FakeDevice = {
        id: randomUUID(),
        kind: "desktop",
        ...grant.device,
        enrolledBy: "browser",
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        credential: `mako_dc_${"a".repeat(30)}${randomUUID().replaceAll("-", "").slice(0, 13)}`,
        removed: false,
      }
      devices.set(device.id, device)
      return send(201, JSON.stringify({ device: publicDevice(device), credential: device.credential, connection: token(device.id), account }))
    }
    if (request.method === "POST" && url.pathname === "/v1/devices/token") {
      if (options.failRefreshes > 0) {
        options.failRefreshes -= 1
        return send(503, JSON.stringify({ title: "The cloud is busy" }))
      }
      const device = [...devices.values()].find((entry) => entry.credential === bearer && !entry.removed)
      if (!device) return send(401, JSON.stringify({ title: "This device was removed", detail: "Sign in again to use it" }))
      return send(200, JSON.stringify({ device: publicDevice(device), connection: token(device.id), account }))
    }
    const caller = verify(bearer)
    if (!caller) return send(401, JSON.stringify({ title: "The connection token isn't valid here" }))
    if (request.method === "GET" && url.pathname === "/v1/devices")
      return send(200, JSON.stringify({ devices: [...devices.values()].filter((device) => !device.removed).map(publicDevice), current: caller.id }))
    if (request.method === "GET" && url.pathname === `/v1/accounts/${account.id}/sign-ins`) return send(200, JSON.stringify({ signIns: [], kept: [] }))
    if (request.method === "POST" && url.pathname === "/v1/bases") {
      const { repositories } = z.object({ repositories: z.array(z.object({ url: z.string(), branch: z.string().optional() })) }).parse(await json(request))
      bases.push(...repositories)
      return send(202, JSON.stringify({ bases: repositories.map((repository) => ({ name: "b-0123456789abcdef", repository })) }))
    }
    if (request.method === "POST" && url.pathname === "/v1/threads") {
      const body = await json(request)
      threads.push(body)
      // A Thread made ahead is ready once it has been asked for before: its machine came up meanwhile.
      const ready = body.prepare === true && threads.filter((made) => made.threadId === body.threadId).length > 1
      return send(201, JSON.stringify({ threadId: body.threadId, home: "cloud", machine: "m-0123456789abcdef", ready }))
    }
    const removing = /^\/v1\/devices\/([\w-]+)$/.exec(url.pathname)?.[1]
    if (request.method === "DELETE" && removing) {
      const device = devices.get(removing)
      if (!device || device.removed) return send(404, JSON.stringify({ title: "No such device" }))
      device.removed = true
      for (const [socket, held] of sockets) if (held.device === removing) goodbye(socket, 4003)
      return send(204)
    }
    send(404, JSON.stringify({ title: "Not found" }))
  })
  /** The reason said first, as the gateway does: `closing` to a client, `refused` to a runtime; then the close. */
  const goodbye = (socket: ServerSocket, code: number) => {
    const reason = code === 4003 ? problem("forbidden", "This device was removed", "c", "not-applied") : problem("unauthorized", "The connection's credential expired", "c", "not-applied")
    socket.send(sockets.get(socket)?.kind === "runtime" ? encodeGatewayFrame({ type: "refused", problem: reason }) : encodeGatewayClientFrame({ type: "closing", problem: reason }))
    socket.close(code, reason.title)
  }
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) })
  server.on("upgrade", (request, socket, head) => {
    const device = verify(offeredCredential(request.headers["sec-websocket-protocol"]))
    if (!device) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return
    }
    const path = new URL(request.url ?? "/", "http://cloud").pathname
    const runtime = /^\/v1\/runtimes\/d-([\w-]+)\/connect$/.exec(path)?.[1]
    const calling = /^\/v1\/runtimes\/([\w-]+)\/clients$/.test(path)
    if (path !== `/v1/accounts/${account.id}/connect` && runtime !== device.id && !calling) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (runtime) return bridgeRuntime(ws, device.id)
      if (calling) return bridgeClient(ws, device.id)
      sockets.set(ws, { device: device.id, kind: "account" })
      ws.on("close", () => sockets.delete(ws))
      ws.on("message", (data) => {
        const text = String(data)
        // Answered by the cloud's edge without waking anything.
        if (text === PING) return ws.send(PONG)
        const frame = decodeClientFrame(text)
        if (frame.type !== "renew") return
        calls.push("renew")
        if (verify(frame.token)?.id === device.id) ws.send(encodeGatewayClientFrame({ type: "renewed", expiresAt: Math.floor(Date.now() / 1000) + options.tokenSeconds }))
        else goodbye(ws, 4001)
      })
    })
  })
  /** A runtime's link, carried to the fake gateway frame by frame, as the real one's object would take it. */
  const bridgeRuntime = (ws: ServerSocket, deviceId: string) => {
    sockets.set(ws, { device: deviceId, kind: "runtime" })
    void gateway.connectRuntime().then((link) => {
      ws.on("message", (data) => {
        const text = String(data)
        if (text === PING) return ws.send(PONG)
        const frame = decodeRuntimeFrame(text)
        if (frame.type === "enroll") enrolments.push(frame)
        if (frame.type === "renew") calls.push("runtime renew")
        link.sendUnchecked(text)
      })
      ws.on("close", () => {
        sockets.delete(ws)
        link.close()
      })
      void (async () => {
        for await (const frame of link.frames()) if (ws.readyState === ws.OPEN) ws.send(encodeGatewayFrame(frame))
        if (ws.readyState === ws.OPEN) ws.close(1000)
      })()
    })
  }
  /** A device's session calling a runtime: its calls carried to the fake gateway, its renewals checked as the account's are. */
  const bridgeClient = (ws: ServerSocket, deviceId: string) => {
    sockets.set(ws, { device: deviceId, kind: "client" })
    ws.on("close", () => sockets.delete(ws))
    const session = gateway.connectClient({ kind: "client", client: "desktop", deviceId })
    ws.on("message", (data) => {
      const text = String(data)
      if (text === PING) return ws.send(PONG)
      const frame = decodeClientFrame(text)
      if (frame.type === "renew") {
        calls.push("client renew")
        if (verify(frame.token)?.id === deviceId) ws.send(encodeGatewayClientFrame({ type: "renewed", expiresAt: Math.floor(Date.now() / 1000) + options.tokenSeconds }))
        else goodbye(ws, 4001)
      } else if (frame.type === "call") {
        void session.then((client) => client.call(frame.operation)).then((reply) => ws.send(encodeGatewayClientFrame({ type: "reply", reply })))
      }
    })
  }
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  // SAFETY: listening on a TCP host and port, so the address is an AddressInfo.
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => {
    for (const socket of sockets.keys()) socket.terminate()
    wss.close()
    server.closeAllConnections()
    server.close()
  })
  return {
    url,
    calls,
    correlations,
    threads,
    bases,
    options,
    stop: () => {
      server.closeAllConnections()
      server.close()
    },
    devices,
    /** What a browser does after the person picks an account: the cloud redirects to the loopback with a code. */
    async approve(signInUrl: string, tamper?: { state?: string }) {
      const page = new URL(signInUrl)
      const code = `code-${randomUUID()}`
      codes.set(code, {
        challenge: page.searchParams.get("code_challenge") ?? "",
        device: { name: page.searchParams.get("device_name") ?? "", platform: page.searchParams.get("platform") ?? "", appVersion: page.searchParams.get("app_version") },
      })
      const callback = new URL(page.searchParams.get("redirect_uri") ?? "")
      callback.searchParams.set("code", code)
      callback.searchParams.set("state", tamper?.state ?? page.searchParams.get("state") ?? "")
      return fetch(callback, { redirect: "manual" })
    },
    account,
    gateway,
    enrolments,
    /** The account connections; `runtimes` are the devices' runtime links. */
    sockets: () => [...sockets].filter(([, held]) => held.kind === "account").map(([socket]) => socket),
    runtimes: () => [...sockets].filter(([, held]) => held.kind === "runtime").map(([socket]) => socket),
    /** Devices' sessions calling a runtime through the cloud. */
    clients: () => [...sockets].filter(([, held]) => held.kind === "client").map(([socket]) => socket),
    dropAll: () => {
      for (const socket of sockets.keys()) socket.terminate()
    },
    closeAll: (code: number) => {
      for (const socket of sockets.keys()) goodbye(socket, code)
    },
  }
}

/** A CloudAccounts with a record of every state it announced. */
function desktop(options: Partial<CloudAccountOptions> & { url: string | undefined }) {
  const states: CloudAccountState[] = []
  const opened: string[] = []
  const waiters = new Set<() => void>()
  const accounts = new CloudAccounts({
    secrets: secrets(),
    secretName: `cloud/${randomUUID()}`,
    openExternal: async (url) => void opened.push(url),
    device: async () => ({ name: "Ada's MacBook Pro", platform: "macOS 26.0", appVersion: "0.4.0" }),
    onChange: (account: CloudAccount) => {
      states.push(account.state)
      for (const waiter of waiters) waiter()
    },
    ...options,
  })
  after(() => accounts.close())
  const until = (predicate: (state: CloudAccountState) => boolean, label: string, ms = 5_000) =>
    new Promise<CloudAccountState>((resolve, reject) => {
      const check = () => {
        const state = accounts.account().state
        if (!predicate(state)) return
        waiters.delete(check)
        clearTimeout(timer)
        resolve(state)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`Timed out waiting for ${label}; last state ${JSON.stringify(accounts.account().state)}`))
      }, ms)
      waiters.add(check)
      check()
    })
  return { accounts, states, opened, until }
}

const connected = (state: CloudAccountState) => state.status === "signed-in" && state.connection === "connected"

/** This Mac's runtime as the host serves it, answering every operation with where it ran. */
const laptop: CloudRuntime = {
  serve: (link, { runtimeId, credential, threads }) =>
    serveRuntime(link, { runtimeId, build: "test", credential, threads, handle: async (operation) => ({ v: PROTOCOL_VERSION, id: operation.id, ok: true, value: Payload.of("ran on this Mac") }) }),
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function signedIn(cloud: Awaited<ReturnType<typeof fakeCloud>>, options: Partial<CloudAccountOptions> = {}) {
  const mac = desktop({ url: cloud.url, ...options })
  await mac.accounts.signIn()
  await cloud.approve(mac.opened.at(-1) ?? "")
  await mac.until(connected, "connected")
  return mac
}

/**
 * A TCP proxy in front of the fake cloud whose `sleep` stops every open connection's bytes both ways without closing
 * it, as a Mac woken on a network the sleep didn't keep finds its pooled connections. Connections opened after pass.
 */
async function sleepyProxy(port: number) {
  const pairs = new Set<{ near: Socket; far: Socket; asleep: boolean }>()
  const proxy = createTcpServer((near) => {
    const pair = { near, far: connect(port, "127.0.0.1"), asleep: false }
    pairs.add(pair)
    near.on("data", (chunk) => pair.asleep || pair.far.write(chunk))
    pair.far.on("data", (chunk) => pair.asleep || near.write(chunk))
    const end = () => {
      pairs.delete(pair)
      near.destroy()
      pair.far.destroy()
    }
    for (const socket of [near, pair.far]) {
      socket.on("close", end)
      socket.on("error", end)
    }
  })
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  after(() => {
    for (const pair of pairs) {
      pair.near.destroy()
      pair.far.destroy()
    }
    proxy.close()
  })
  // SAFETY: listening on a TCP host and port, so the address is an AddressInfo.
  return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, sleep: () => pairs.forEach((pair) => (pair.asleep = true)) }
}

test("after a sleep, a call to the cloud never waits on a pooled connection the network dropped", async () => {
  const cloud = await fakeCloud()
  const network = await sleepyProxy(Number(new URL(cloud.url).port))
  const mac = await signedIn(cloud, { url: network.url })
  // The pool settles: each call made while it was awake is answered and its connection idle again.
  for (let call = 0; call < 3; call++) {
    await mac.accounts.signIns()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  network.sleep()
  // Node's timers stopped while the Mac slept, so the pooled connection looks fresh: a call put on it hears nothing.
  const stalled = mac.accounts.signIns().then(() => "answered", () => "dropped")
  assert.equal(await Promise.race([stalled, new Promise((resolve) => setTimeout(() => resolve("waiting"), 1_500))]), "waiting", "on the dropped connection, a call waits")
  const woke = performance.now()
  mac.accounts.wake()
  await mac.accounts.signIns()
  const ms = performance.now() - woke
  console.log(`  a call to the cloud right after waking: ${ms.toFixed(0)} ms`)
  assert.ok(ms < 1_000, `answered on a new connection in ${ms.toFixed(0)} ms`)
  assert.equal(await stalled, "dropped", "the call stranded before the wake ends rather than hanging")
})

test("a build without a cloud, or with one it may not reach, offers no sign-in", async () => {
  for (const [url, fixture, message] of [
    [undefined, false, /aren't available in this build/],
    ["not a url", false, /isn't a URL/],
    ["http://cloud.example.com", false, /must use https/],
    ["https://cloud.example.com", true, /fixture desk signs in only to a Mako cloud running on this Mac/],
  ] as const) {
    const { accounts } = desktop({ url, fixture })
    const { state } = await accounts.ready()
    assert.equal(state.status, "unavailable")
    assert.match(state.status === "unavailable" ? state.message : "", message)
    await assert.rejects(accounts.signIn(), message)
  }
  const { accounts } = desktop({ url: "http://127.0.0.1:9", fixture: true })
  assert.equal((await accounts.ready()).state.status, "signed-out", "a fixture desk may sign in to a cloud on loopback")
})

test("signing in through the browser enrolls this Mac, keeps its credential sealed, and connects", async () => {
  const cloud = await fakeCloud()
  const mac = desktop({ url: cloud.url })
  const account = await mac.accounts.signIn()
  assert.equal(account.cloud, new URL(cloud.url).host)
  assert.equal(account.state.status, "signing-in")
  const page = new URL(mac.opened[0] ?? "")
  assert.equal(page.origin + page.pathname, `${cloud.url}/sign-in`)
  assert.equal(page.searchParams.get("code_challenge_method"), "S256")
  assert.match(page.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  assert.equal(page.searchParams.get("device_name"), "Ada's MacBook Pro")
  assert.equal(page.searchParams.get("device_kind"), "desktop")

  await mac.accounts.signIn()
  assert.equal(mac.opened.length, 2, "asking again while waiting reopens the page")
  assert.equal(mac.opened[1], mac.opened[0], "and it's the same sign-in")

  const forged = await cloud.approve(mac.opened[0] ?? "", { state: "someone-else" })
  assert.equal(forged.status, 303)
  assert.equal(forged.headers.get("location"), `${cloud.url}/sign-in/done?result=failed`)
  assert.equal(mac.accounts.account().state.status, "signing-in", "a callback with the wrong state finishes nothing")

  const browser = await cloud.approve(mac.opened[0] ?? "")
  assert.equal(browser.status, 303)
  assert.equal(browser.headers.get("location"), `${cloud.url}/sign-in/done`, "the browser lands on the cloud's done page after enrolment")
  const state = await mac.until(connected, "connected")
  assert.equal(state.status === "signed-in" && state.account.email, "ada@example.com")
  assert.equal(state.status === "signed-in" && state.kept, "keychain")
  assert.deepEqual(
    mac.states.map((entry) => (entry.status === "signed-in" ? `signed-in:${entry.connection}` : entry.status)),
    ["signing-in", "signed-in:connecting", "signed-in:connected"]
  )

  const device = [...cloud.devices.values()][0]
  assert.ok(device)
  const files = (await readdir(vault, { recursive: true })).filter((name) => /data-key$|\.json$/.test(name))
  const written = await Promise.all(files.map((name) => readFile(join(vault, name), "utf8")))
  const keyFile = JSON.parse(await readFile(join(vault, "data-key"), "utf8"))
  assert.ok(Buffer.from(keyFile.wrapped, "base64").toString().startsWith("sealed:"), "the data key is kept wrapped by the keychain")
  assert.ok(written.some((text) => text.includes('"sealer":"aes-256-gcm"')), "the credential is written sealed")
  assert.ok(!written.some((text) => text.includes(device.credential)), "never in the clear")

  const port = new URL(page.searchParams.get("redirect_uri") ?? "").port
  await assert.rejects(fetch(`http://127.0.0.1:${port}/callback`), "the loopback listener is gone once signed in")
})

test("the sign-in survives a restart and reconnects from the sealed credential", async () => {
  const cloud = await fakeCloud()
  const secretName = "cloud/restart"
  const first = await signedIn(cloud, { secretName })
  assert.equal(((await stat(recordPath(secretName))).mode & 0o777).toString(8), "600")
  first.accounts.close()

  const again = desktop({ url: cloud.url, secretName })
  const resumed = await again.accounts.ready()
  assert.equal(resumed.state.status, "signed-in", "the first answer after a restart is already signed in")
  await again.until(connected, "reconnected")

  const elsewhere = desktop({ url: "http://127.0.0.1:1", secretName })
  assert.equal((await elsewhere.accounts.ready()).state.status, "signed-out", "another cloud's credential is never used")
})

test("a fresh token is handed over the open socket before the old one lapses", async () => {
  const cloud = await fakeCloud()
  cloud.options.tokenSeconds = 3
  const mac = await signedIn(cloud)
  const socket = cloud.sockets()[0]
  await sleep(2_200)
  assert.ok(cloud.calls.includes("renew"), "renewed over the socket")
  assert.equal(cloud.sockets()[0], socket, "without reconnecting")
  assert.ok(connected(mac.accounts.account().state))
})

test("a cloud clock far from this Mac's doesn't make every token look expired", async () => {
  const cloud = await fakeCloud()
  cloud.options.clockSkewSeconds = -3_600
  await signedIn(cloud)
  await sleep(1_500)
  assert.equal(cloud.calls.filter((call) => call === "POST /v1/devices/token").length, 0, "the enrolment's token is still good")
  assert.ok(!cloud.calls.includes("renew"))
})

test("a dropped connection comes back by itself; an expired token reconnects at once", async () => {
  const cloud = await fakeCloud()
  // Shown offline only once it has been down a while: here a tenth of a second, so the drop shows.
  const mac = await signedIn(cloud, { offlineAfterMs: 100 })
  cloud.dropAll()
  await mac.until((state) => state.status === "signed-in" && state.connection === "offline", "offline")
  await mac.until(connected, "reconnected after a drop")

  const refreshes = cloud.calls.filter((call) => call === "POST /v1/devices/token").length
  const started = Date.now()
  const before = cloud.sockets()[0]
  cloud.closeAll(4001)
  while (cloud.sockets().length !== 1 || cloud.sockets()[0] === before) await sleep(10)
  assert.ok(Date.now() - started < 500, "no backoff for an expired token")
  assert.ok(connected(mac.accounts.account().state), "and no flicker to offline while it reconnects")
  assert.equal(cloud.calls.filter((call) => call === "POST /v1/devices/token").length, refreshes + 1, "after exactly one refresh")
})

test("removed from another device, this Mac signs out at once and forgets its credential", async () => {
  const cloud = await fakeCloud()
  const secretName = "cloud/removed"
  const mac = await signedIn(cloud, { secretName })
  const other = await signedIn(cloud)
  const own = mac.accounts.account().state
  assert.equal(own.status, "signed-in")
  const { devices } = await other.accounts.devices()
  assert.equal(devices.length, 2)
  await other.accounts.removeDevice(own.status === "signed-in" ? own.device.id : "")
  const state = await mac.until((entry) => entry.status === "signed-out", "signed out")
  assert.equal(state.status === "signed-out" && state.notice?.kind, "removed")
  await assert.rejects(stat(recordPath(secretName)), "the credential file is gone")
  assert.ok(connected(other.accounts.account().state), "the other device stays connected")
})

test("a Mac removed while Mako was closed finds out on its first refresh", async () => {
  const cloud = await fakeCloud()
  const secretName = "cloud/removed-offline"
  const mac = await signedIn(cloud, { secretName })
  mac.accounts.close()
  for (const device of cloud.devices.values()) device.removed = true
  const again = desktop({ url: cloud.url, secretName })
  assert.equal((await again.accounts.ready()).state.status, "signed-in", "it doesn't know yet")
  const state = await again.until((entry) => entry.status === "signed-out", "signed out on resume")
  assert.equal(state.status === "signed-out" && state.notice?.kind, "removed")
})

test("signing out removes this device from the account", async () => {
  const cloud = await fakeCloud()
  const secretName = "cloud/sign-out"
  const mac = await signedIn(cloud, { secretName })
  const account = await mac.accounts.signOut()
  assert.deepEqual(account.state, { status: "signed-out" }, "no notice: the person did it")
  assert.ok([...cloud.devices.values()].every((device) => device.removed))
  await assert.rejects(stat(recordPath(secretName)))
  assert.deepEqual((await mac.accounts.signOut()).state, { status: "signed-out" }, "signing out twice is signing out once")
})

test("without a keychain the sign-in lasts until Mako quits and nothing is written", async () => {
  const cloud = await fakeCloud()
  const secretName = "cloud/no-keychain"
  const mac = await signedIn(cloud, { secretName, secrets: secrets(noKeychain) })
  const state = mac.accounts.account().state
  assert.equal(state.status === "signed-in" && state.kept, "memory")
  await assert.rejects(stat(recordPath(secretName)))
})

test("every call to the cloud goes under its own correlation ID, and is reported by route, never by path", async () => {
  const cloud = await fakeCloud()
  const reported: DiagnosticEvents["cloud.request"][] = []
  const loggedCalls: string[] = []
  const mac = await signedIn(cloud, {
    onRequest: (call) => void reported.push(call),
    log: (_message, fields) => {
      if (fields?.correlationId !== undefined) loggedCalls.push(String(fields.route))
    },
  })
  await mac.accounts.devices()
  await assert.rejects(mac.accounts.removeDevice("not-a-device"), /No such device/)

  assert.deepEqual(
    reported.map(({ route, outcome, status }) => ({ route, outcome, status })),
    [
      { route: "devices.enroll", outcome: "ok", status: 201 },
      { route: "devices.list", outcome: "ok", status: 200 },
      { route: "devices.remove", outcome: "refused", status: 404 },
    ]
  )
  const sent = cloud.correlations.filter((id) => id !== undefined)
  assert.equal(sent.length, cloud.calls.length, "every call carries one")
  assert.deepEqual(
    reported.map((call) => call.correlationId),
    sent,
    "the ID reported is the ID the cloud saw"
  )
  assert.equal(new Set(sent).size, sent.length, "no two calls share one")
  for (const call of reported) assert.ok(Number.isInteger(call.ms) && call.ms >= 0)
  assert.deepEqual(loggedCalls, ["devices.remove"], "only what failed is logged")

  cloud.stop()
  await assert.rejects(mac.accounts.devices())
  assert.equal(reported.at(-1)?.outcome, "unreachable")
  assert.equal(reported.at(-1)?.status, undefined)
})

test("a cloud Thread made ahead is asked for as one, reported apart from a start, and its answer says when its machine is ready", async () => {
  const cloud = await fakeCloud()
  const reported: DiagnosticEvents["cloud.request"][] = []
  const mac = await signedIn(cloud, { onRequest: (call) => void reported.push(call) })
  const repository = { url: "https://github.com/octocat/Hello-World" }
  assert.deepEqual(await mac.accounts.createThread("t-0123456789abcdef", repository, { prepare: true }), { ready: false })
  assert.deepEqual(await mac.accounts.createThread("t-0123456789abcdef", repository, { prepare: true }), { ready: true }, "asked again, its machine is there")
  assert.deepEqual(await mac.accounts.createThread("t-fedcba9876543210", repository), { ready: false })
  assert.deepEqual(cloud.threads.map((made) => made.prepare === true), [true, true, false], "only a Thread made ahead says so")
  assert.deepEqual(reported.filter((call) => call.route.startsWith("threads.")).map((call) => call.route), ["threads.prepare", "threads.prepare", "threads.create"])
})

test("project bases are asked for with the repositories only, reported as their own route", async () => {
  const cloud = await fakeCloud()
  const reported: DiagnosticEvents["cloud.request"][] = []
  const mac = await signedIn(cloud, { onRequest: (call) => void reported.push(call) })
  await mac.accounts.askBases([{ url: "https://github.com/octocat/Hello-World" }])
  assert.deepEqual(cloud.bases, [{ url: "https://github.com/octocat/Hello-World" }])
  assert.equal(reported.at(-1)?.route, "bases.ask")
})

test("cancelling closes the loopback listener; a code that fails to enroll says so", async () => {
  const cloud = await fakeCloud()
  const mac = desktop({ url: cloud.url })
  await mac.accounts.signIn()
  const redirect = new URL(new URL(mac.opened[0] ?? "").searchParams.get("redirect_uri") ?? "")
  assert.deepEqual(mac.accounts.cancelSignIn().state, { status: "signed-out" })
  await assert.rejects(fetch(redirect), "nothing listens after cancelling")
  assert.deepEqual(mac.accounts.cancelSignIn().state, { status: "signed-out" }, "cancelling twice is harmless")

  await mac.accounts.signIn()
  const page = new URL(mac.opened.at(-1) ?? "")
  page.searchParams.set("code_challenge", "not-the-challenge-for-this-verifier-000000")
  const response = await cloud.approve(page.toString())
  assert.equal(response.headers.get("location"), `${cloud.url}/sign-in/done?result=failed`)
  const state = await mac.until((entry) => entry.status === "signed-out", "failed")
  assert.equal(state.status === "signed-out" && state.notice?.kind, "failed")
  assert.match(state.status === "signed-out" ? (state.notice?.message ?? "") : "", /sign-in code isn't valid/)
})

test("a reconnect over in seconds, after a deploy or a network change, is never shown", async () => {
  const cloud = await fakeCloud()
  const mac = await signedIn(cloud)
  const before = mac.states.length
  cloud.dropAll()
  while (cloud.sockets().length !== 1) await sleep(10)
  await sleep(200)
  assert.ok(connected(mac.accounts.account().state))
  assert.deepEqual(mac.states.slice(before), [], "not one state changed: nothing a person could see")
})

test("a token refresh that fails while renewing is tried again, and the connection never drops", async () => {
  const cloud = await fakeCloud()
  cloud.options.tokenSeconds = 3
  const mac = await signedIn(cloud)
  const socket = cloud.sockets()[0]
  // The first renewal's refresh fails; the next try, a second later, gets one.
  cloud.options.failRefreshes = 1
  await sleep(3_400)
  assert.ok(cloud.calls.includes("renew"), "renewed over the socket after the failed refresh")
  assert.equal(cloud.sockets()[0], socket, "on the same connection")
  assert.ok(connected(mac.accounts.account().state))
})

test("with the cloud entitlement this Mac is the account's runtime, d-<device>, and answers its other devices", async () => {
  const cloud = await fakeCloud()
  const mac = await signedIn(cloud, { runtime: laptop })
  const state = mac.accounts.account().state
  const runtimeId = `d-${state.status === "signed-in" ? state.device.id : ""}`
  while (cloud.enrolments.length === 0) await sleep(10)
  assert.equal(cloud.enrolments[0]?.runtimeId, runtimeId)
  const phone = await cloud.gateway.connectClient({ kind: "client", client: "phone", deviceId: "phone-1" })
  const reply = await phone.call({ v: PROTOCOL_VERSION, id: randomUUID(), op: "files.read", target: { kind: "runtime", runtimeId }, input: Payload.of({}), correlationId: randomUUID(), actor: { kind: "client", client: "phone", deviceId: "phone-1" }, attempt: 1 })
  assert.equal(reply.ok && reply.value?.decode(), "ran on this Mac")
})

test("without the cloud entitlement nothing of the runtime ever runs; an upgrade starts it, its end stops it", async () => {
  const cloud = await fakeCloud()
  cloud.account.entitlements = []
  cloud.options.tokenSeconds = 2
  const mac = await signedIn(cloud, { runtime: laptop })
  await sleep(300)
  assert.equal(cloud.runtimes().length, 0, "a free account: no runtime link at all")
  cloud.account.entitlements = ["cloud"]
  // The upgrade reaches this Mac with its next token, a second or so on here.
  while (cloud.runtimes().length === 0) await sleep(20)
  assert.ok(connected(mac.accounts.account().state))
  cloud.account.entitlements = []
  while (cloud.runtimes().length !== 0) await sleep(20)
  assert.ok(connected(mac.accounts.account().state), "the account's own connection stays")
})

test("the runtime's link comes back by itself and claims its Threads, so the gateway keeps them with it", async () => {
  const cloud = await fakeCloud()
  const mac = await signedIn(cloud, { runtime: laptop })
  const state = mac.accounts.account().state
  const runtimeId = `d-${state.status === "signed-in" ? state.device.id : ""}`
  while (cloud.enrolments.length === 0) await sleep(10)
  const generation = await cloud.gateway.assign("th-1", runtimeId)
  await sleep(100)
  for (const socket of cloud.runtimes()) socket.terminate()
  while (cloud.enrolments.length < 2) await sleep(10)
  assert.deepEqual(cloud.enrolments[1]?.threads, [{ threadId: "th-1", generation }], "claimed again on the new link")
  assert.ok(connected(mac.accounts.account().state), "and no one saw it")
})

test("a device removed while its runtime is connected signs out, and its runtime stops", async () => {
  const cloud = await fakeCloud()
  const mac = await signedIn(cloud, { runtime: laptop })
  const other = await signedIn(cloud)
  while (cloud.runtimes().length === 0) await sleep(10)
  const own = mac.accounts.account().state
  await other.accounts.removeDevice(own.status === "signed-in" ? own.device.id : "")
  const state = await mac.until((entry) => entry.status === "signed-out", "signed out")
  assert.equal(state.status === "signed-out" && state.notice?.kind, "removed")
  await sleep(200)
  assert.equal(cloud.runtimes().length, 0)
})

/** Another device's call to `runtimeId` through its session, as that device. */
function callThrough(session: ReturnType<CloudAccounts["session"]>, from: CloudAccounts, runtimeId: string) {
  const state = from.account().state
  const actor = { kind: "client", client: "desktop", deviceId: state.status === "signed-in" ? state.device.id : "" } as const
  return session.call({ v: PROTOCOL_VERSION, id: randomUUID(), op: "files.read", target: { kind: "runtime", runtimeId }, input: Payload.of({}), correlationId: randomUUID(), actor, attempt: 1 })
}

test("another Mac calls this one through the cloud as itself; its session renews in the socket, and signing out closes it", async () => {
  const cloud = await fakeCloud()
  // Tokens 3 s long are due as soon as they're handed out, so the session renews about every second.
  cloud.options.tokenSeconds = 3
  const mac = await signedIn(cloud, { runtime: laptop })
  const studio = await signedIn(cloud)
  const own = mac.accounts.account().state
  const runtimeId = `d-${own.status === "signed-in" ? own.device.id : ""}`
  while (cloud.enrolments.length === 0) await sleep(10)
  const session = studio.accounts.session()
  const first = await callThrough(session, studio.accounts, runtimeId)
  assert.equal(first.ok && first.value?.decode(), "ran on this Mac")
  const socket = cloud.clients()[0]
  while (!cloud.calls.includes("client renew")) await sleep(20)
  const second = await callThrough(session, studio.accounts, runtimeId)
  assert.equal(second.ok && second.value?.decode(), "ran on this Mac")
  assert.deepEqual(cloud.clients(), [socket], "renewed in place, on the same connection")
  await studio.accounts.signOut()
  while (cloud.clients().length) await sleep(10)
})

test("a device removed while its session is open signs out, and its session's connections close", async () => {
  const cloud = await fakeCloud()
  const mac = await signedIn(cloud, { runtime: laptop })
  const studio = await signedIn(cloud)
  const own = mac.accounts.account().state
  const runtimeId = `d-${own.status === "signed-in" ? own.device.id : ""}`
  while (cloud.enrolments.length === 0) await sleep(10)
  const session = studio.accounts.session()
  await callThrough(session, studio.accounts, runtimeId)
  assert.equal(cloud.clients().length, 1)
  const removing = studio.accounts.account().state
  await mac.accounts.removeDevice(removing.status === "signed-in" ? removing.device.id : "")
  const state = await studio.until((entry) => entry.status === "signed-out", "signed out")
  assert.equal(state.status === "signed-out" && state.notice?.kind, "removed")
  while (cloud.clients().length) await sleep(10)
  const later = await callThrough(session, studio.accounts, runtimeId)
  assert.equal(later.ok, false, "a signed-out device's session calls nothing")
})

test("a grant or a revoke while signed in reads the sign-ins again, with nothing else asking", async () => {
  const cloud = await fakeCloud()
  cloud.account.entitlements = []
  cloud.options.tokenSeconds = 2
  delete process.env.MAKO_CLOUD_URL
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  const opened: string[] = []
  const shown: CloudSignInsState[] = []
  const unused = async (): Promise<never> => {
    throw new Error("Not used by the account")
  }
  const machine: Machine = { kind: "present", offer: unused, reveal: unused, open: unused, openUrl: async (url) => void opened.push(url), copy: unused, chooseFolder: unused, defaultBrowser: unused, thumbnail: unused }
  const registry = new ProviderRegistry<ProviderAccountCapability>()
  const dataRoot = join(scratch, randomUUID())
  const account = declareCloudAccountMethods(
    methods,
    {
      environment: { dataRoot, version: "0.4.0", build: { makoCloud: cloud.url } },
      secrets: { secrets: secrets(), adoptLegacy: () => {} },
      machine,
      emit: (event) => {
        if (event.type === "cloud-sign-ins") shown.push(event.signIns)
      },
      fixture: false,
      // Sharing is on by default; with no harnesses here, there's nothing of this Mac's to read.
      harnessSignIns: (options) => new CloudSignInSync({ ...options, accounts: new HarnessAccounts(registry), capabilities: registry }),
    }
  )
  after(() => account.stop())
  const until = async (blocked: string | undefined, label: string) => {
    const deadline = Date.now() + 5_000
    while (!shown.length || shown.at(-1)?.blocked !== blocked) {
      if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}; last shown ${JSON.stringify(shown.at(-1))}`)
      await sleep(20)
    }
  }
  await methods.invoke("mako:cloud-sign-in", [])
  await cloud.approve(opened[0] ?? "")
  while (!(await account.deviceId())) await sleep(10)
  // As Settings reads it: an account without the cloud can't keep sign-ins there.
  const read = z.object({ sharing: z.literal(true), blocked: z.string().optional() }).loose()
  assert.equal(read.parse(JSON.parse(z.string().parse(await methods.invoke("mako:cloud-sign-ins", [], "web", true)))).blocked, "no-cloud")
  shown.length = 0
  cloud.account.entitlements = ["cloud"]
  // The grant reaches this Mac with its next token, a second or so on here, and the sign-ins follow it.
  await until(undefined, "the grant")
  cloud.account.entitlements = []
  await until("no-cloud", "the revoke")
})
