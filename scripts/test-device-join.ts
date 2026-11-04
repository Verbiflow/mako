/**
 * A machine with no browser joins its person's account with a code (RFC 8628's device grant, `mako-host join`),
 * against a stand-in for the gateway's OAuth endpoints that answers as the gateway does: pending, slow_down, denied,
 * expired and approved. Its sign-in is the one a browser's makes, kept under a data key in a 0600 file of its own when
 * no keychain or desktop can give one, and a host started after it runs as that device, its runtime link connected
 * with the cloud or the devices entitlement.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import {
  PING,
  PONG,
  PROTOCOL_VERSION,
  Payload,
  SUBPROTOCOL,
  decodeClientFrame,
  encodeGatewayClientFrame,
  encodeGatewayFrame,
  offeredCredential,
  serveRuntime,
  servesDeviceRuntime,
} from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { CloudAccounts, type CloudAccountOptions, type CloudRuntime, type DeviceCode } from "@mako/host/usage/cloud-account"
import type { CloudAccountState, CloudDevice } from "@mako/host/contracts/cloud-account"
import type { JsonValue } from "@mako/host/contracts/json"
import { aesSealer, fileKey, fileSecrets, SecretLocked } from "@mako/host/base/secrets"
import { openHostSecrets, secretKeyFile } from "@mako/host/base/host-secrets"
import { linuxPlatform, onMac } from "@mako/host/base/platform"
import type { SecretEncryption } from "@mako/host/base/secure-storage"

const scratch = await mkdtemp(join(tmpdir(), "mako-device-join-"))
after(() => rm(scratch, { recursive: true, force: true }))

type Answer = "pending" | "slow_down" | "approved" | "access_denied" | "expired_token"
type FakeDevice = CloudDevice & { credential: string; removed: boolean }
/** What the next code's polls hear, in order, and the lifetime and interval it's given. */
type Plan = { answers: Answer[]; expiresIn: number; interval: number }

/** The gateway's device grant, device tokens and links, in memory. `answers`: what each poll of the next code hears, in order. */
async function fakeGateway(entitlements: string[] = ["cloud"]) {
  const account = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null, entitlements }
  const devices = new Map<string, FakeDevice>()
  const asked: Array<Record<string, string>> = []
  /** When each poll came, by this process's clock, and what it was answered. */
  const polls: Array<{ at: number; answer: string }> = []
  const plan: Plan = { answers: [], expiresIn: 60, interval: 1 }
  let pending: { deviceCode: string; userCode: string; form: Record<string, string> } | undefined
  const sockets = new Map<ServerSocket, "account" | "runtime">()
  const gateway = createFakeGateway({ renew: () => Math.floor(Date.now() / 1000) + 300 })
  const token = (deviceId: string) => {
    const iat = Math.floor(Date.now() / 1000)
    const body = Buffer.from(JSON.stringify({ sub: account.id, did: deviceId, iat, exp: iat + 300 })).toString("base64url")
    return { token: `eyJhbGciOiJFZERTQSJ9.${body}.signature`, expiresAt: iat + 300 }
  }
  const deviceOfToken = (value: string | undefined) => {
    const claims = value && JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString())
    const device = claims && devices.get(claims.did)
    return device && !device.removed ? device : undefined
  }
  const publicDevice = ({ credential: _credential, removed: _removed, ...device }: FakeDevice): CloudDevice => device
  const body = async (request: IncomingMessage) => {
    let text = ""
    for await (const chunk of request) text += chunk
    return text
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://gateway")
    const send = (status: number, value?: JsonValue) => response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(value === undefined ? undefined : JSON.stringify(value))
    const oauth = (error: string) => send(400, { error, error_description: `answered ${error}` })
    if (request.method === "POST" && url.pathname.startsWith("/oauth/")) {
      assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded", "OAuth's requests are form-encoded")
      const form = Object.fromEntries(new URLSearchParams(await body(request)))
      if (form.client_id !== "mako-runtime") return send(401, { error: "invalid_client" })
      if (url.pathname === "/oauth/device/code") {
        asked.push(form)
        pending = { deviceCode: `mako_dvc_${randomUUID()}`, userCode: "BCDF-GHJK", form }
        return send(200, {
          device_code: pending.deviceCode,
          user_code: pending.userCode,
          verification_uri: `${address}/device`,
          verification_uri_complete: `${address}/device?code=${pending.userCode}`,
          expires_in: plan.expiresIn,
          interval: plan.interval,
        })
      }
      if (url.pathname === "/oauth/token") {
        assert.equal(form.grant_type, "urn:ietf:params:oauth:grant-type:device_code")
        if (!pending || form.device_code !== pending.deviceCode) return oauth("invalid_grant")
        const answer = plan.answers.shift() ?? "pending"
        polls.push({ at: performance.now(), answer })
        if (answer !== "approved") return oauth(answer === "pending" ? "authorization_pending" : answer)
        const device: FakeDevice = {
          id: randomUUID(),
          kind: "runtime",
          name: pending.form.device_name ?? "",
          platform: pending.form.platform ?? "",
          appVersion: pending.form.app_version ?? null,
          enrolledBy: "device-code",
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          credential: `mako_dc_${"r".repeat(30)}${randomUUID().replaceAll("-", "").slice(0, 13)}`,
          removed: false,
        }
        devices.set(device.id, device)
        pending = undefined
        const connection = token(device.id)
        return send(200, { access_token: connection.token, token_type: "Bearer", expires_in: 300, refresh_token: device.credential, device: publicDevice(device), account })
      }
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1]
    if (request.method === "POST" && url.pathname === "/v1/devices/token") {
      const device = [...devices.values()].find((entry) => entry.credential === bearer && !entry.removed)
      if (!device) return send(401, { title: "This device was removed" })
      return send(200, { device: publicDevice(device), account, connection: token(device.id) })
    }
    const caller = deviceOfToken(bearer)
    if (!caller) return send(401, { title: "The connection token isn't valid here" })
    if (request.method === "GET" && url.pathname === "/v1/devices") return send(200, { devices: [...devices.values()].filter((device) => !device.removed).map(publicDevice), current: caller.id })
    const removing = /^\/v1\/devices\/([\w-]+)$/.exec(url.pathname)?.[1]
    if (request.method === "DELETE" && removing) {
      const device = devices.get(removing)
      if (!device || device.removed) return send(404, { title: "No such device" })
      device.removed = true
      for (const socket of sockets.keys()) socket.terminate()
      return send(204)
    }
    send(404, { title: "Not found" })
  })
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) })
  server.on("upgrade", (request, socket, head) => {
    const device = deviceOfToken(offeredCredential(request.headers["sec-websocket-protocol"]))
    const path = new URL(request.url ?? "/", "http://gateway").pathname
    const runtime = /^\/v1\/runtimes\/d-([\w-]+)\/connect$/.exec(path)?.[1]
    // The gateway's rule for a device's runtime: its own, with the cloud or the devices entitlement.
    const admitted = device && (path === `/v1/accounts/${account.id}/connect` || (runtime === device.id && servesDeviceRuntime(account.entitlements)))
    if (!admitted) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.set(ws, runtime ? "runtime" : "account")
      ws.on("close", () => sockets.delete(ws))
      if (!runtime) {
        ws.on("message", (data) => {
          const text = String(data)
          if (text === PING) return ws.send(PONG)
          const frame = decodeClientFrame(text)
          if (frame.type === "renew") ws.send(encodeGatewayClientFrame({ type: "renewed", expiresAt: Math.floor(Date.now() / 1000) + 300 }))
        })
        return
      }
      void gateway.connectRuntime().then((link) => {
        ws.on("message", (data) => {
          const text = String(data)
          if (text === PING) return ws.send(PONG)
          link.sendUnchecked(text)
        })
        ws.on("close", () => link.close())
        void (async () => {
          for await (const frame of link.frames()) if (ws.readyState === ws.OPEN) ws.send(encodeGatewayFrame(frame))
        })()
      })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  // SAFETY: listening on a TCP host and port, so the address is an AddressInfo.
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => {
    for (const socket of sockets.keys()) socket.terminate()
    wss.close()
    server.closeAllConnections()
    server.close()
  })
  return {
    url: address,
    account,
    devices,
    asked,
    polls,
    plan,
    runtimes: () => [...sockets.values()].filter((kind) => kind === "runtime").length,
    links: () => sockets.size,
  }
}

/** A machine with no keychain and no desktop: its store's data key in a file of its own. */
const noKeychain: SecretEncryption = {
  available: async () => false,
  encrypt: async () => assert.fail("no keychain here"),
  decrypt: async () => assert.fail("no keychain here"),
}

/** A machine's store under `root`, as the host opens it with no keychain: `keyFile` keeps its data key. */
function machineStore(root: string) {
  const keyFile = join(root, "secrets", "host-key")
  return { keyFile, secrets: openHostSecrets({ userRoot: root, keychain: noKeychain, legacy: [], keyFile }).secrets }
}

/** This machine's CloudAccounts, with every state it announced, and `until` to wait for one. */
function machine(options: Partial<CloudAccountOptions> & Pick<CloudAccountOptions, "url" | "secrets">) {
  const states: CloudAccountState[] = []
  const waiters = new Set<() => void>()
  const accounts = new CloudAccounts({
    secretName: "cloud/device",
    openExternal: async () => assert.fail("a device with no browser never opens one"),
    device: async () => ({ name: "build-box", platform: linuxPlatform("x64", 'NAME="Ubuntu"\nVERSION_ID="24.04"\n', "6.8.0"), appVersion: "0.4.0" }),
    onChange: (account) => {
      states.push(account.state)
      for (const waiter of waiters) waiter()
    },
    ...options,
  })
  after(() => accounts.close())
  const until = (predicate: (state: CloudAccountState) => boolean, label: string, ms = 5_000) =>
    new Promise<CloudAccountState>((resolve, reject) => {
      const check = () => {
        if (!predicate(accounts.account().state)) return
        waiters.delete(check)
        clearTimeout(timer)
        resolve(accounts.account().state)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`Timed out waiting for ${label}; last state ${JSON.stringify(accounts.account().state)}`))
      }, ms)
      waiters.add(check)
      check()
    })
  return { accounts, states, until }
}

/** The host as a device serves it, answering every operation with where it ran. */
const server: CloudRuntime = {
  serve: (link, { runtimeId, credential, threads }) =>
    serveRuntime(link, { runtimeId, build: "test", credential, threads, handle: async (operation) => ({ v: PROTOCOL_VERSION, id: operation.id, ok: true, value: Payload.of("ran on the device") }) }),
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("joining shows the code and where to confirm it, waits at the cloud's interval and longer after slow_down, and keeps the device's sign-in", async () => {
  const gateway = await fakeGateway()
  gateway.plan.answers = ["pending", "slow_down", "approved"]
  const root = join(scratch, "approved")
  const store = machineStore(root)
  const box = machine({ url: gateway.url, secrets: store.secrets, links: false })
  const shown: DeviceCode[] = []
  const joined = await box.accounts.join((code) => void shown.push(code))

  assert.deepEqual(gateway.asked, [{ client_id: "mako-runtime", device_name: "build-box", platform: "Linux x64 · Ubuntu 24.04", app_version: "0.4.0" }], "it names itself as the runtime client, with its name, platform and version")
  assert.equal(shown.length, 1)
  assert.equal(shown[0]?.code, "BCDF-GHJK")
  assert.equal(shown[0]?.verificationUriComplete, `${gateway.url}/device?code=BCDF-GHJK`, "the page it shows carries the code")
  assert.equal(shown[0]?.verificationUri, `${gateway.url}/device`)
  const signingIn = box.states.find((state) => state.status === "signing-in")
  assert.equal(signingIn?.status === "signing-in" && signingIn.code, "BCDF-GHJK", "its state says the code while it waits")

  // RFC 8628 §3.5: never sooner than the interval, and five seconds longer from a slow_down on.
  const [first, second, third] = gateway.polls
  assert.deepEqual(gateway.polls.map((poll) => poll.answer), ["pending", "slow_down", "approved"])
  assert.ok(first && second && third)
  assert.ok(second.at - first.at >= 950, `polled ${Math.round(second.at - first.at)} ms after the first, within the interval`)
  assert.ok(third.at - second.at >= 5_950, `polled ${Math.round(third.at - second.at)} ms after slow_down, under the longer interval`)

  assert.equal(joined.state.status, "signed-in")
  assert.equal(joined.state.status === "signed-in" && joined.state.device.kind, "runtime")
  assert.equal(joined.state.status === "signed-in" && joined.state.kept, "keychain", "kept durably, as a keychain's sign-in is")
  assert.equal(gateway.links(), 0, "a command that joins opens no link of its own")

  // Kept sealed under the key file's key: the record names no credential, and the key file is the owner's alone.
  const device = [...gateway.devices.values()][0]
  assert.ok(device)
  const records = (await readdir(join(root, "secrets"), { recursive: true })).filter((name) => name.endsWith(".json"))
  assert.deepEqual(records, [join("mako-sign-in", "cloud", "device.json")])
  assert.ok(!(await readFile(join(root, "secrets", records[0] ?? ""), "utf8")).includes(device.credential), "the credential is never in the clear")
  assert.equal(((await stat(store.keyFile)).mode & 0o777).toString(8), "600")
})

test("a host started after the join runs as that device, its runtime link connected", async () => {
  const gateway = await fakeGateway()
  gateway.plan.answers = ["approved"]
  const root = join(scratch, "restart")
  const joining = machine({ url: gateway.url, secrets: machineStore(root).secrets, links: false })
  await joining.accounts.join(() => {})
  joining.accounts.close()

  const host = machine({ url: gateway.url, secrets: machineStore(root).secrets, runtime: server })
  const resumed = await host.accounts.ready()
  assert.equal(resumed.state.status, "signed-in", "the first answer after the restart is already signed in")
  const linked = await host.until((state) => state.status === "signed-in" && state.connection === "connected" && state.runtime === "connected", "both links connected")
  assert.equal(linked.status === "signed-in" && linked.device.kind, "runtime")
  assert.equal(gateway.runtimes(), 1)
})

test("a code refused on the other device, or one that expired, signs nothing in", async () => {
  for (const [answer, kind, message] of [
    ["access_denied", "failed", /refused on the other device/],
    ["expired_token", "timed-out", /expired before it was confirmed/],
  ] as const) {
    const gateway = await fakeGateway()
    gateway.plan.answers = ["pending", answer]
    const root = join(scratch, answer)
    const box = machine({ url: gateway.url, secrets: machineStore(root).secrets, links: false })
    const ended = await box.accounts.join(() => {})
    assert.equal(ended.state.status, "signed-out")
    assert.equal(ended.state.status === "signed-out" && ended.state.notice?.kind, kind)
    assert.match(ended.state.status === "signed-out" ? (ended.state.notice?.message ?? "") : "", message)
    assert.equal(gateway.devices.size, 0)
    await assert.rejects(stat(join(root, "secrets", "mako-sign-in")), "nothing is kept")
  }
})

test("a code past its lifetime stops the asking by itself, and an abort stops it at once", async () => {
  const gateway = await fakeGateway()
  gateway.plan.expiresIn = 2
  const box = machine({ url: gateway.url, secrets: machineStore(join(scratch, "lapsed")).secrets, links: false })
  const lapsed = await box.accounts.join(() => {})
  assert.equal(lapsed.state.status === "signed-out" && lapsed.state.notice?.kind, "timed-out")
  assert.ok(gateway.polls.length <= 2, `asked ${gateway.polls.length} times in its two seconds`)

  const stop = new AbortController()
  const waiting = box.accounts.join(() => setTimeout(() => stop.abort(), 100), stop.signal)
  await assert.rejects(waiting, { name: "AbortError" })
  assert.equal(box.accounts.account().state.status, "signed-out")
})

test("the runtime link connects with the devices entitlement as with the cloud's, and never without either", async () => {
  for (const [entitlements, runs] of [
    [["devices"], true],
    [["cloud"], true],
    [[], false],
  ] as const) {
    const gateway = await fakeGateway([...entitlements])
    gateway.plan.answers = ["approved"]
    const box = machine({ url: gateway.url, secrets: machineStore(join(scratch, `entitled-${entitlements.join("-") || "none"}`)).secrets, runtime: server })
    await box.accounts.join(() => {})
    await box.until((state) => state.status === "signed-in" && state.connection === "connected", "the account's link")
    if (runs) await box.until((state) => state.status === "signed-in" && state.runtime === "connected", "the runtime's link")
    else await sleep(300)
    assert.equal(gateway.runtimes(), runs ? 1 : 0, `entitled to ${JSON.stringify(entitlements)}`)
    const state = box.accounts.account().state
    assert.equal(state.status === "signed-in" && state.runtime, runs ? "connected" : "off")
  }
  assert.equal(servesDeviceRuntime(["free"]), false)
})

test("leaving removes the device from the account and forgets its sign-in", async () => {
  const gateway = await fakeGateway()
  gateway.plan.answers = ["approved"]
  const root = join(scratch, "leave")
  const box = machine({ url: gateway.url, secrets: machineStore(root).secrets, links: false })
  await box.accounts.join(() => {})
  const after = await box.accounts.signOut()
  assert.equal(after.state.status, "signed-out")
  assert.equal([...gateway.devices.values()][0]?.removed, true)
  assert.deepEqual(await readdir(join(root, "secrets", "mako-sign-in"), { recursive: true }).then((names) => names.filter((name) => name.endsWith(".json"))), [])
})

test("the key file is made once, mode 0600 in a 0700 folder, reused after a restart, and a damaged one opens nothing", async () => {
  const root = join(scratch, "key-file")
  const first = machineStore(root)
  assert.equal(await first.secrets.durable(), true, "with a key file, a machine without a keychain keeps secrets")
  await first.secrets.write("mako-sign-in", "cloud/device", "kept")
  assert.equal(((await stat(first.keyFile)).mode & 0o777).toString(8), "600")
  assert.equal(((await stat(join(root, "secrets"))).mode & 0o777).toString(8), "700")
  const key = await readFile(first.keyFile, "utf8")
  assert.equal(Buffer.from(key.trim(), "base64").length, 32)

  const again = machineStore(root)
  assert.equal((await again.secrets.read("mako-sign-in", "cloud/device"))?.value, "kept", "the next start opens what the last kept")
  assert.equal(await readFile(first.keyFile, "utf8"), key, "with the same key, never made again")

  // Without a key file, as before: nothing outlives the process.
  assert.equal(await openHostSecrets({ userRoot: join(scratch, "no-key-file"), keychain: noKeychain, legacy: [] }).secrets.durable(), false)

  // A key made elsewhere works; one that isn't 32 bytes opens nothing.
  const made = join(scratch, "made-key")
  await writeFile(made, `${Buffer.alloc(32, 7).toString("base64")}\n`, { mode: 0o600 })
  assert.deepEqual(await fileKey(made).key(false), Buffer.alloc(32, 7))
  await writeFile(made, "c2hvcnQ=\n")
  await assert.rejects(fileKey(made).key(false), (error) => error instanceof SecretLocked && error.reason === "unreadable")
  await assert.rejects(fileSecrets(join(scratch, "made-store"), aesSealer(fileKey(made))).write("saved-key", "x", "y"), SecretLocked)
})

test("where the key file is: MAKO_SECRET_KEY_FILE, else the user root off a Mac; never on a cloud machine", () => {
  assert.equal(secretKeyFile("/data", { env: { MAKO_SECRET_KEY_FILE: "/run/secrets/mako-key" }, cloudMachine: false }), "/run/secrets/mako-key")
  assert.equal(secretKeyFile("/data", { env: {}, cloudMachine: true }), undefined)
  assert.equal(secretKeyFile("/data", { env: {}, cloudMachine: false }), onMac() ? undefined : join("/data", "secrets", "host-key"))
})

test("a Linux device names its architecture and distribution", () => {
  assert.equal(linuxPlatform("x64", 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\n', "6.8.0"), "Linux x64 · Ubuntu 24.04")
  assert.equal(linuxPlatform("arm64", "NAME=Alpine\n", "6.6.1"), "Linux arm64 · Alpine")
  assert.equal(linuxPlatform("x64", 'PRETTY_NAME="Some Linux"\n', "6.6.1"), "Linux x64 · Some Linux")
  assert.equal(linuxPlatform("x64", undefined, "6.8.0-45-generic"), "Linux x64 · 6.8.0-45-generic")
})
