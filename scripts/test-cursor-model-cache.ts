import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CURSOR_ACCOUNT_TTL_MS, CURSOR_SDK_AUTH_FILE, createCursorModelCache, listCursorSdkModels } from "@mako/host/harnesses/cursor/sdk/models"
import { createCursorSdkDriver, type CursorSdkLiveClient } from "@mako/host/harnesses/cursor/sdk/driver"
import { CursorSdkAuth, type CursorSdkSpawnOptions } from "@mako/host/harnesses/cursor/sdk/auth"
import { CursorCredentialStore } from "@mako/host/harnesses/cursor/sdk/credentials"
import { memorySecrets } from "@mako/host/base/secrets"
import { CURSOR_SDK_WIRE_VERSION, type SdkMethod, type SdkResult, type SdkModelListItem } from "@mako/host/harnesses/cursor/sdk/wire"
import { admitted } from "./fixtures/admitted-start.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

type FixtureAnswers = { [K in SdkMethod]?: () => SdkResult<K> }

const catalog = (key: string): SdkModelListItem[] => [{ id: key, displayName: key }]
const keyA = { CURSOR_API_KEY: "key_fixture_a_0123456789" }
const keyB = { CURSOR_API_KEY: "key_fixture_b_0123456789" }
let now = 1, calls = 0
const cache = createCursorModelCache(() => now)
let release!: (models: SdkModelListItem[]) => void
const first = cache(keyA, () => { calls++; return new Promise(resolve => { release = resolve }) })
const same = cache({ ...keyA, MAKO_CONVERSATIONS_TOKEN: "session-only", PATH: "/session/bin" }, async () => { calls++; return catalog("wrong") }, true)
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(calls, 1, "display/startup overlap uses one native list, whatever else their environments hold")
const other = await cache(keyB, async () => catalog("B"))
assert.equal(other[0].id, "B", "another credential cannot join the pending account")
release(catalog("A"))
const [a, b] = await Promise.all([first, same])
a[0].displayName = "mutated"
assert.equal(b[0].displayName, "A", "callers cannot mutate one another's model list")
assert.equal((await cache(keyA, async () => catalog("wrong")))[0].id, "A")
assert.equal((await cache(keyA, async () => catalog("fresh"), true))[0].id, "fresh", "display refresh stays native")
assert.equal((await cache({ ...keyA, CURSOR_BACKEND_URL: "https://fixture.invalid" }, async () => catalog("endpoint")))[0].id, "endpoint")
now += CURSOR_ACCOUNT_TTL_MS
assert.equal((await cache(keyA, async () => catalog("expired")))[0].id, "expired")
await assert.rejects(cache(keyA, async () => { throw Error("network fixture") }, true), /network fixture/)
assert.equal((await cache(keyA, async () => catalog("wrong")))[0].id, "expired", "a failed refresh preserves the still-valid native result")
assert.equal((await cache(keyA, async () => catalog("recovered"), true))[0].id, "recovered", "failed refresh requests are not cached")
await assert.rejects(cache(keyA, async () => [], true), /no models/)
assert.equal((await cache(keyA, async () => catalog("nonempty"), true))[0].id, "nonempty")
// Without a key in its environment the SDK runs as its own sign-in file says, as on a cloud machine: the file is the credential.
const sdkHome = await mkdtemp(join(tmpdir(), "mako-cursor-sdk-home-"))
const sdkAuth = join(sdkHome, CURSOR_SDK_AUTH_FILE)
const fileOnly = { HOME: sdkHome }
assert.equal((await cache(fileOnly, async () => catalog("no-file-a")))[0].id, "no-file-a")
assert.equal((await cache(fileOnly, async () => catalog("no-file-b")))[0].id, "no-file-b", "with no key and no sign-in file, nothing says who: no list is kept")
await mkdir(dirname(sdkAuth), { recursive: true })
await writeFile(sdkAuth, JSON.stringify({ version: 1, apiKey: "key_fixture_file_a", backendUrl: "https://fixture.invalid", createdAtMs: 1 }))
assert.equal((await cache(fileOnly, async () => catalog("file-a")))[0].id, "file-a")
assert.equal((await cache({ ...fileOnly, PATH: "/elsewhere" }, async () => catalog("wrong")))[0].id, "file-a", "the SDK's own sign-in keeps its list for the hour")
await writeFile(sdkAuth, JSON.stringify({ version: 1, apiKey: "key_fixture_file_b", backendUrl: "https://fixture.invalid", createdAtMs: 2 }))
assert.equal((await cache(fileOnly, async () => catalog("file-b")))[0].id, "file-b", "another sign-in in the file is another account")
await cache.forget(fileOnly)
assert.equal((await cache(fileOnly, async () => catalog("file-b-again")))[0].id, "file-b-again", "a credential Cursor refused is forgotten")
await rm(sdkHome, { recursive: true, force: true })


let refreshResult!: (models: SdkModelListItem[]) => void
const refreshing = cache(keyA, () => new Promise(resolve => { refreshResult = resolve }), true)
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal((await cache(keyA, async () => catalog("wrong")))[0].id, "nonempty", "launch cannot wait for display refresh while exact-account evidence is valid")
now += CURSOR_ACCOUNT_TTL_MS
let staleReturned = false
const expiredDuringRefresh = cache(keyA, async () => catalog("wrong")).then(value => { staleReturned = true; return value })
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(staleReturned, false, "expired evidence cannot bypass an in-flight native refresh")
refreshResult(catalog("refreshed"))
await refreshing
assert.equal((await expiredDuringRefresh)[0].id, "refreshed")
assert.equal((await cache(keyA, async () => catalog("wrong")))[0].id, "refreshed")
const unseen = { CURSOR_API_KEY: "uncached-failure" }
await assert.rejects(cache(unseen, async () => { throw Error("first failure") }), /first failure/)
assert.equal((await cache(unseen, async () => catalog("retry")))[0].id, "retry")

const obsoleteOwner = new AbortController()
const cancelledCache = createCursorModelCache()
const oldGate = Promise.withResolvers<SdkModelListItem[]>()
const oldDiscovery = cancelledCache(keyA, () => oldGate.promise, true, obsoleteOwner.signal)
const cancelled = assert.rejects(oldDiscovery, /superseded/)
await new Promise<void>(resolve => setImmediate(resolve))
obsoleteOwner.abort(new Error("superseded fixture discovery"))
assert.equal((await cancelledCache(keyA, async () => catalog("replacement"), true))[0].id, "replacement", "a new owner cannot join the cancelled catalog request")
oldGate.resolve(catalog("obsolete"))
await cancelled
assert.equal((await cancelledCache(keyA, async () => catalog("wrong")))[0].id, "replacement", "late cleanup cannot remove the replacement catalog")

const modelOwner = new AbortController()
const helloGate = Promise.withResolvers<{ wire: number; sdkVersion: string; node: string }>()
const closeGate = Promise.withResolvers<void>()
let closes = 0
let modelRequests = 0
const modelRequest = listCursorSdkModels({ env: keyA, signal: modelOwner.signal, client: () => ({
  hello: () => helloGate.promise,
  request: async () => { modelRequests++; throw new Error("No model request after cancellation") },
  close: async () => { closes++; await closeGate.promise },
}) })
let finished = false
const refusedModels = assert.rejects(modelRequest, /cancelled fixture models/).then(() => { finished = true })
modelOwner.abort(new Error("cancelled fixture models"))
helloGate.resolve({ wire: CURSOR_SDK_WIRE_VERSION, sdkVersion: "fixture", node: process.version })
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(closes, 1, "cancellation closes the exact discovery client once")
assert.equal(modelRequests, 0, "a cancelled handshake cannot advance to model discovery")
assert.equal(finished, false, "the query retains its cleanup boundary until close settles")
closeGate.resolve()
await refusedModels
await assert.rejects(listCursorSdkModels({ env: keyA, signal: modelOwner.signal, client: () => { throw new Error("Pre-aborted discovery cannot spawn") } }), /cancelled fixture models/)

const root = await mkdtemp(join(tmpdir(), "mako-cursor-model-cache-"))
let env = keyA
const requests: string[] = []
const identityRequests: string[] = []
let offered: string[] = []
const spawned: string[] = []
const methods: string[] = []
const closed: string[] = []
const client = (options: CursorSdkSpawnOptions): CursorSdkLiveClient => (spawned.push(options.owner), {
  alive: true, exited: new Promise(() => {}), kill() {}, close: async () => { closed.push(options.owner) },
  hello: async () => ({ wire: CURSOR_SDK_WIRE_VERSION, sdkVersion: "fixture", node: process.version }),
  request: async <M extends SdkMethod>(method: M): Promise<SdkResult<M>> => {
    methods.push(method)
    // Slower than every other step, as a child's first call to Cursor is.
    if (method === "me") { await new Promise((resolve) => setTimeout(resolve, 30)); methods.push("me answered") }
    const answers: FixtureAnswers = {
      me: () => { identityRequests.push(options.env.CURSOR_API_KEY!); return { email: "same@example.test", apiKeyName: "same-name", createdAt: "2026-09-25" } },
      models: () => { requests.push(options.env.CURSOR_API_KEY!); return { models: [...catalog(options.env.CURSOR_API_KEY!), ...offered.flatMap(catalog)] } },
      // Once a newer model is offered the child reports none, so the session reports the model the driver selected.
      open: () => ({ agentId: options.owner, model: offered.length ? undefined : { id: options.env.CURSOR_API_KEY! } }),
    }
    const answer = answers[method]
    if (!answer) throw Error(`Unexpected ${method}`)
    return answer()
  },
})
const shared = createCursorModelCache()
const auth = new CursorSdkAuth({
  env: async () => ({ ...env }), cliKey: async () => null, openUrl: async () => { throw Error("no login") }, client,
  credentials: new CursorCredentialStore(memorySecrets({ durable: false })),
})
const driver = createCursorSdkDriver({ stores: nativeStores, auth, stateRoot: () => root, home: root, client, modelCache: shared })
try {
  // Display discovery fills the same provider-owned cache used by the actual driver.
  await shared(keyA, async () => catalog(keyA.CURSOR_API_KEY), true)
  const a = await driver.start(root, admitted("cursor", { conversationId: "A", emit() {} }, { env }))
  assert.equal(a.settings?.model, keyA.CURSOR_API_KEY)
  assert.equal(requests.length, 0, "startup reuses native display discovery")
  env = keyB
  const b = await driver.start(root, admitted("cursor", { conversationId: "B", emit() {} }, { env }))
  assert.equal(b.settings?.model, keyB.CURSOR_API_KEY, "same public identity cannot reuse another credential's models")
  assert.deepEqual(requests, [keyB.CURSOR_API_KEY])
  env = keyA
  await driver.start(root, admitted("cursor", { conversationId: "A2", emit() {} }, { env }))
  assert.deepEqual(requests, [keyB.CURSOR_API_KEY])
  // Each session asks who it runs as on its own child: the first call there, which its `open` would pay otherwise.
  assert.equal(identityRequests.filter((key) => key === keyA.CURSOR_API_KEY).length, 3, "the sign-in check and both of A's sessions")

  // The start run ahead keeps its child, its SDK loaded, and the stage after sign-in asks the account's models on it;
  // the start then finds them. No third child loads the SDK beside the run-ahead's and the session's.
  const keyC = { CURSOR_API_KEY: "key_fixture_c_0123456789" }
  const prefetch = driver.startPrefetch!
  assert.equal(await prefetch.run(keyC, root, "prefetch:cursor"), true)
  assert.equal(closed.includes("prefetch:cursor"), false, "the run-ahead's child is kept for the stage after sign-in")
  const children = spawned.length
  await prefetch.signedIn!(keyC)
  assert.equal(spawned.length, children, "the stage asks on the kept child")
  assert.equal(closed.filter((owner) => owner === "prefetch:cursor").length, 1, "and stops it once it has asked")
  assert.equal(requests.at(-1), keyC.CURSOR_API_KEY)
  const asked = [requests.length, identityRequests.length + 1]
  env = keyC
  methods.length = 0
  const c = await driver.start(root, admitted("cursor", { conversationId: "C", emit() {} }, { env }))
  assert.ok(methods.indexOf("me answered") >= 0 && methods.indexOf("me answered") < methods.indexOf("open"), `open waits for the child's first call, me: ${methods.join(", ")}`)
  assert.equal(c.settings?.model, keyC.CURSOR_API_KEY)
  assert.equal(c.executionContext?.identity?.kind, "reported", "the identity kept is still Cursor's answer")
  assert.deepEqual([requests.length, identityRequests.length], asked, "the start asks its models of nobody, and who it is of its own child")

  // A model Cursor began offering after the list was kept: asked again once, never refused from the kept list.
  offered = ["fixture-new-model"]
  const d = await driver.start(root, admitted("cursor", { conversationId: "D", emit() {}, tuning: { model: "fixture-new-model" } }, { env }))
  assert.equal(d.settings?.model, "fixture-new-model", "the start opens the model it asked for")
  assert.equal(requests.length, asked[0] + 1, "a missing model asks Cursor once more")
  await assert.rejects(driver.start(root, admitted("cursor", { conversationId: "E", emit() {}, tuning: { model: "fixture-never" } }, { env })), /does not offer the model "fixture-never"/)
  // A stage with no kept child after a session already asked spawns nothing; `release` stops a child no sign-in follows.
  const before = spawned.length
  await prefetch.signedIn!({ CURSOR_API_KEY: "key_fixture_d_0123456789" })
  assert.equal(spawned.length, before, "a session has asked already: no child is spawned for the stage")
  assert.equal(await prefetch.run(keyC, root, "prefetch:release"), true)
  prefetch.release!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(closed.includes("prefetch:release"), "release stops the kept child")
  // With neither a kept child nor a session, the stage spawns its own.
  const fresh = createCursorSdkDriver({ stores: nativeStores, auth, stateRoot: () => root, home: root, client, modelCache: createCursorModelCache() })
  const count = spawned.length
  await fresh.startPrefetch!.signedIn!(keyC)
  assert.equal(spawned.length, count + 1)
  assert.ok(closed.includes("prefetch:cursor") && closed.filter((owner) => owner === "prefetch:cursor").length === 2, "its own child is stopped")
} finally {
  for (const id of ["A", "B", "A2", "C", "D"]) await driver.close(id)
  await rm(root, { recursive: true, force: true })
}
console.log("Cursor native discovery: overlap, credential/endpoint/sign-in-file isolation, an hour's reuse, refresh, failures, the signed-in stage run ahead and production startup reuse passed")
