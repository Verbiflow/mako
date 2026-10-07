/**
 * The desktop's Mako account against a fake cloud that speaks the gateway's
 * protocol: the loopback hand-off with PKCE, the encrypted credential, token
 * renewal over the open socket, reconnecting, and being removed elsewhere.
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { CloudAccounts, type CloudAccountOptions } from "../electron/cloud-account.ts"
import type { CloudAccount, CloudAccountState, CloudDevice } from "../electron/contracts/cloud-account.ts"
import type { SecretEncryption } from "../electron/secure-storage.ts"

const scratch = await mkdtemp(join(tmpdir(), "mako-cloud-account-"))
after(() => rm(scratch, { recursive: true, force: true }))

/** Reversible and recognisable, so the test can tell the file holds no credential in the clear. */
const encryption: SecretEncryption = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64").split("").reverse().join("")}`),
  decrypt: async (value) => Buffer.from(value.toString().slice("sealed:".length).split("").reverse().join(""), "base64").toString(),
}
const noKeychain: SecretEncryption = { ...encryption, available: async () => false }

type FakeDevice = CloudDevice & { credential: string; removed: boolean }

/** The gateway's identity API, in memory. */
async function fakeCloud() {
  const codes = new Map<string, { challenge: string; device: Pick<CloudDevice, "name" | "platform" | "appVersion"> }>()
  const devices = new Map<string, FakeDevice>()
  const sockets = new Map<ServerSocket, string>()
  const calls: string[] = []
  const options = { tokenSeconds: 300, clockSkewSeconds: 0, refuseTokens: false }
  const account = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null, entitlements: ["cloud"] }
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
      const device = [...devices.values()].find((entry) => entry.credential === bearer && !entry.removed)
      if (!device) return send(401, JSON.stringify({ title: "This device was removed", detail: "Sign in again to use it" }))
      return send(200, JSON.stringify({ device: publicDevice(device), connection: token(device.id), account }))
    }
    const caller = verify(bearer)
    if (!caller) return send(401, JSON.stringify({ title: "The connection token isn't valid here" }))
    if (request.method === "GET" && url.pathname === "/v1/devices")
      return send(200, JSON.stringify({ devices: [...devices.values()].filter((device) => !device.removed).map(publicDevice), current: caller.id }))
    const removing = /^\/v1\/devices\/([\w-]+)$/.exec(url.pathname)?.[1]
    if (request.method === "DELETE" && removing) {
      const device = devices.get(removing)
      if (!device || device.removed) return send(404, JSON.stringify({ title: "No such device" }))
      device.removed = true
      for (const [socket, id] of sockets) if (id === removing) goodbye(socket, 4003, "This device was removed")
      return send(204)
    }
    send(404, JSON.stringify({ title: "Not found" }))
  })
  const goodbye = (socket: ServerSocket, code: number, reason: string) => {
    socket.send(JSON.stringify({ type: "bye", code, reason }))
    socket.close(code, reason)
  }
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("mako.v1") ? "mako.v1" : false) })
  server.on("upgrade", (request, socket, head) => {
    const offered = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((entry) => entry.trim())
    const device = verify(offered.find((entry) => entry.startsWith("mako.token."))?.slice("mako.token.".length))
    if (!device) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.set(ws, device.id)
      ws.on("close", () => sockets.delete(ws))
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data))
        if (frame.type === "ping") ws.send('{"type":"pong"}')
        if (frame.type === "token") {
          calls.push("renew")
          const renewed = verify(frame.token)
          if (renewed?.id === device.id) ws.send(JSON.stringify({ type: "token-accepted", expiresAt: 0 }))
          else goodbye(ws, 4001, "That token isn't for this device")
        }
      })
      ws.send(JSON.stringify({ type: "hello", deviceId: device.id }))
    })
  })
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
    options,
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
    sockets: () => [...sockets.keys()],
    dropAll: () => {
      for (const socket of sockets.keys()) socket.terminate()
    },
    closeAll: (code: number) => {
      for (const socket of sockets.keys()) goodbye(socket, code, "closing")
    },
  }
}

/** A CloudAccounts with a record of every state it announced. */
function desktop(options: Partial<CloudAccountOptions> & { url: string | undefined }) {
  const states: CloudAccountState[] = []
  const opened: string[] = []
  const waiters = new Set<() => void>()
  const accounts = new CloudAccounts({
    storePath: join(scratch, `${randomUUID()}.bin`),
    encryption,
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function signedIn(cloud: Awaited<ReturnType<typeof fakeCloud>>, options: Partial<CloudAccountOptions> = {}) {
  const mac = desktop({ url: cloud.url, ...options })
  await mac.accounts.signIn()
  await cloud.approve(mac.opened.at(-1) ?? "")
  await mac.until(connected, "connected")
  return mac
}

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
  const sealed = await Promise.all((await readdir(scratch)).map((name) => readFile(join(scratch, name), "utf8")))
  assert.ok(sealed.some((text) => text.startsWith("sealed:")), "the credential is written sealed")
  assert.ok(!sealed.some((text) => text.includes(device.credential)), "never in the clear")

  const port = new URL(page.searchParams.get("redirect_uri") ?? "").port
  await assert.rejects(fetch(`http://127.0.0.1:${port}/callback`), "the loopback listener is gone once signed in")
})

test("the sign-in survives a restart and reconnects from the sealed credential", async () => {
  const cloud = await fakeCloud()
  const storePath = join(scratch, "restart.bin")
  const first = await signedIn(cloud, { storePath })
  assert.equal(((await stat(storePath)).mode & 0o777).toString(8), "600")
  first.accounts.close()

  const again = desktop({ url: cloud.url, storePath })
  const resumed = await again.accounts.ready()
  assert.equal(resumed.state.status, "signed-in", "the first answer after a restart is already signed in")
  await again.until(connected, "reconnected")

  const elsewhere = desktop({ url: "http://127.0.0.1:1", storePath })
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
  const mac = await signedIn(cloud)
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
  const storePath = join(scratch, "removed.bin")
  const mac = await signedIn(cloud, { storePath })
  const other = await signedIn(cloud)
  const own = mac.accounts.account().state
  assert.equal(own.status, "signed-in")
  const { devices } = await other.accounts.devices()
  assert.equal(devices.length, 2)
  await other.accounts.removeDevice(own.status === "signed-in" ? own.device.id : "")
  const state = await mac.until((entry) => entry.status === "signed-out", "signed out")
  assert.equal(state.status === "signed-out" && state.notice?.kind, "removed")
  await assert.rejects(stat(storePath), "the credential file is gone")
  assert.ok(connected(other.accounts.account().state), "the other device stays connected")
})

test("a Mac removed while Mako was closed finds out on its first refresh", async () => {
  const cloud = await fakeCloud()
  const storePath = join(scratch, "removed-offline.bin")
  const mac = await signedIn(cloud, { storePath })
  mac.accounts.close()
  for (const device of cloud.devices.values()) device.removed = true
  const again = desktop({ url: cloud.url, storePath })
  assert.equal((await again.accounts.ready()).state.status, "signed-in", "it doesn't know yet")
  const state = await again.until((entry) => entry.status === "signed-out", "signed out on resume")
  assert.equal(state.status === "signed-out" && state.notice?.kind, "removed")
})

test("signing out removes this device from the account", async () => {
  const cloud = await fakeCloud()
  const storePath = join(scratch, "sign-out.bin")
  const mac = await signedIn(cloud, { storePath })
  const account = await mac.accounts.signOut()
  assert.deepEqual(account.state, { status: "signed-out" }, "no notice: the person did it")
  assert.ok([...cloud.devices.values()].every((device) => device.removed))
  await assert.rejects(stat(storePath))
  assert.deepEqual((await mac.accounts.signOut()).state, { status: "signed-out" }, "signing out twice is signing out once")
})

test("without a keychain the sign-in lasts until Mako quits and nothing is written", async () => {
  const cloud = await fakeCloud()
  const storePath = join(scratch, "no-keychain.bin")
  const mac = await signedIn(cloud, { storePath, encryption: noKeychain })
  const state = mac.accounts.account().state
  assert.equal(state.status === "signed-in" && state.kept, "memory")
  await assert.rejects(stat(storePath))
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
