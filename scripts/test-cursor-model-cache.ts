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
import { AppKeySchema } from "@mako/host/contracts/thread-environments"

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
/** Each child by the owner it was spawned for, what it was asked, and each adoption with what it was given. */
const asked: string[] = []
const adoptions: Array<{ from: string; owner: string; cwd: string; thread: string | undefined }> = []
const client = (options: CursorSdkSpawnOptions): CursorSdkLiveClient => {
  spawned.push(options.owner)
  const spawnedFor = options.owner
  let owner = options.owner
  return {
  alive: true, exited: new Promise(() => {}), kill() {}, close: async () => { closed.push(owner) },
  hello: async () => ({ wire: CURSOR_SDK_WIRE_VERSION, sdkVersion: "fixture", node: process.version }),
  adopt: async (input) => {
    adoptions.push({ from: owner, owner: input.owner, cwd: input.cwd, thread: input.env.MAKO_THREAD_DATA_DIR })
    owner = input.owner
  },
  request: async <M extends SdkMethod>(method: M): Promise<SdkResult<M>> => {
    methods.push(method)
    asked.push(`${spawnedFor}:${method}`)
    // Slower than every other step, as a child's first call to Cursor is.
    if (method === "me") { await new Promise((resolve) => setTimeout(resolve, 30)); methods.push("me answered") }
    const answers: FixtureAnswers = {
      me: () => { identityRequests.push(options.env.CURSOR_API_KEY!); return { email: "same@example.test", apiKeyName: "same-name", createdAt: "2026-09-25" } },
      models: () => { requests.push(options.env.CURSOR_API_KEY!); return { models: [...catalog(options.env.CURSOR_API_KEY!), ...offered.flatMap(catalog)] } },
      // Once a newer model is offered the child reports none, so the session reports the model the driver selected.
      open: () => ({ agentId: owner, model: offered.length ? undefined : { id: options.env.CURSOR_API_KEY! } }),
    }
    const answer = answers[method]
    if (!answer) throw Error(`Unexpected ${method}`)
    return answer()
  },
  }
}
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

  // The start run ahead keeps its child, its SDK loaded; the stage after sign-in asks the account's models on it, and
  // the start takes it as its own: no third child loads the SDK, and the session's spawns nothing.
  const keyC = { CURSOR_API_KEY: "key_fixture_c_0123456789" }
  const prefetch = driver.startPrefetch!
  const stop = new AbortController()
  assert.equal(await prefetch.run(keyC, root, "prefetch:cursor", stop.signal), true)
  const children = spawned.length
  await prefetch.signedIn!(keyC)
  assert.equal(spawned.length, children, "the stage asks on the kept child")
  assert.deepEqual(asked.filter((entry) => entry.startsWith("prefetch:cursor:")), ["prefetch:cursor:models"])
  assert.equal(closed.includes("prefetch:cursor"), false, "and keeps it for the start")
  stop.abort()
  env = keyC
  methods.length = 0
  const thread = { app: AppKeySchema.parse("folder-0123456789abcdef"), host: "fixture.thread.localhost", port: 20000, ports: 10, dataDir: join(root, "thread-data") }
  const c = await driver.start(root, admitted("cursor", { conversationId: "C", emit() {}, threadEnvironment: thread }, { env }))
  assert.equal(spawned.length, children, "the start spawns no child: it takes the one run ahead")
  assert.deepEqual(adoptions.at(-1), { from: "prefetch:cursor", owner: "C", cwd: root, thread: thread.dataDir }, "with the session's owner, folder and environment")
  assert.deepEqual(asked.filter((entry) => entry.startsWith("prefetch:cursor:")), ["prefetch:cursor:models", "prefetch:cursor:me", "prefetch:cursor:open"], "the session asks who it is and opens on it, its models kept")
  assert.ok(methods.indexOf("me answered") >= 0 && methods.indexOf("me answered") < methods.indexOf("open"), `open waits for the child's first call, me: ${methods.join(", ")}`)
  assert.equal(c.settings?.model, keyC.CURSOR_API_KEY)
  assert.equal(c.executionContext?.identity?.kind, "reported", "who it runs as is still Cursor's answer")
  assert.equal(c.executionContext?.runtime?.kind, "reported", "the runtime is the kept child's own hello")
  await driver.close("C")
  assert.ok(closed.includes("C"), "the session closes the child it took")
  const counted = requests.length

  // Another account's start doesn't take it: the kept child stops and the start spawns its own.
  assert.equal(await prefetch.run(keyB, root, "prefetch:other", new AbortController().signal), true)
  env = keyC
  await driver.start(root, admitted("cursor", { conversationId: "C2", emit() {} }, { env }))
  assert.ok(closed.includes("prefetch:other"), "a child spawned for another credential is stopped")
  assert.ok(spawned.includes("C2"), "and the start spawns its own")
  await driver.close("C2")

  // A model Cursor began offering after the list was kept: asked again once, never refused from the kept list.
  offered = ["fixture-new-model"]
  const d = await driver.start(root, admitted("cursor", { conversationId: "D", emit() {}, tuning: { model: "fixture-new-model" } }, { env }))
  assert.equal(d.settings?.model, "fixture-new-model", "the start opens the model it asked for")
  assert.equal(requests.length, counted + 1, "a missing model asks Cursor once more")
  await assert.rejects(driver.start(root, admitted("cursor", { conversationId: "E", emit() {}, tuning: { model: "fixture-never" } }, { env })), /does not offer the model "fixture-never"/)
  // A stage with no kept child after a session already asked spawns nothing; `release` stops a child no sign-in follows.
  const before = spawned.length
  await prefetch.signedIn!({ CURSOR_API_KEY: "key_fixture_d_0123456789" })
  assert.equal(spawned.length, before, "a session has asked already: no child is spawned for the stage")
  assert.equal(await prefetch.run(keyC, root, "prefetch:release", new AbortController().signal), true)
  prefetch.release!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(closed.includes("prefetch:release"), "release stops the kept child")
  // With neither a kept child nor a session, the stage spawns its own.
  const fresh = createCursorSdkDriver({ stores: nativeStores, auth, stateRoot: () => root, home: root, client, modelCache: createCursorModelCache() })
  const count = spawned.length
  await fresh.startPrefetch!.signedIn!(keyC)
  assert.equal(spawned.length, count + 1)
  assert.equal(closed.filter((owner) => owner === "prefetch:cursor").length, 1, "its own child is stopped")
  // A fresh machine keeps no sign-in answer: the start asks it of its own child, beside who it is and its models, and
  // spawns nothing else.
  {
    const freshAuth = new CursorSdkAuth({
      env: async () => ({ ...keyA }), cliKey: async () => null, openUrl: async () => { throw Error("no login") }, client,
      credentials: new CursorCredentialStore(memorySecrets({ durable: false })),
    })
    const fresh = createCursorSdkDriver({ stores: nativeStores, auth: freshAuth, stateRoot: () => root, home: root, client, modelCache: createCursorModelCache() })
    const before = spawned.length
    asked.length = 0
    methods.length = 0
    env = keyA
    await fresh.start(root, admitted("cursor", { conversationId: "F", emit() {} }, { env }))
    assert.deepEqual(spawned.slice(before), ["F"], "only the session's own child")
    assert.deepEqual(asked.filter((entry) => entry.startsWith("F:")).sort(), ["F:hello", "F:me", "F:me", "F:models", "F:open"].filter((entry) => entry !== "F:hello").sort(), "the sign-in check's me, its own me, its models, then open")
    assert.ok(methods.indexOf("open") > methods.lastIndexOf("me answered"), "open after every answer")
    assert.equal(freshAuth.current?.state.status, "signed-in", "the answer is kept as a check's would be")
    await fresh.close("F")
  }

  // The stage's question never answers on the kept child: a start waits for it 3 s, not the 20 s a hung question took
  // on a copy, then stops that child, and its own question and session go on as without one run ahead.
  {
    const keyH = { CURSOR_API_KEY: "key_fixture_h_0123456789" }
    const killed: string[] = []
    let asked = false
    const hanging = (options: CursorSdkSpawnOptions): CursorSdkLiveClient => {
      const base = client(options)
      if (options.owner !== "prefetch:hang") return base
      let fail: (error: Error) => void = () => undefined
      return {
        ...base,
        kill: () => { killed.push(options.owner); fail(new Error("The Cursor SDK process closed before answering")) },
        request: async <M extends SdkMethod>(method: M, params: Parameters<typeof base.request<M>>[1]): Promise<SdkResult<M>> => {
          if (method !== "models") return base.request(method, params)
          asked = true
          return new Promise<SdkResult<M>>((_, reject) => { fail = reject })
        },
      }
    }
    const hung = createCursorSdkDriver({ stores: nativeStores, auth, stateRoot: () => root, home: root, client: hanging, modelCache: createCursorModelCache() })
    assert.equal(await hung.startPrefetch!.run(keyH, root, "prefetch:hang", new AbortController().signal), true)
    void hung.startPrefetch!.signedIn!(keyH).catch(() => undefined)
    while (!asked) await new Promise<void>((resolve) => setTimeout(resolve, 5))
    env = keyH
    const began = performance.now()
    const started = await hung.start(root, admitted("cursor", { conversationId: "H", emit() {} }, { env }))
    const waited = performance.now() - began
    assert.deepEqual(killed, ["prefetch:hang"], "the child still asking is stopped")
    assert.ok(waited >= 2_900 && waited < 6_000, `the start waited for it ${Math.round(waited)} ms, not 20 s`)
    assert.ok(spawned.includes("H"), "and the start spawned its own")
    assert.equal(started.settings?.model, keyH.CURSOR_API_KEY, "whose models it asked itself")
    await hung.close("H")
  }
} finally {
  for (const id of ["A", "B", "A2", "D"]) await driver.close(id)
  await rm(root, { recursive: true, force: true })
}
console.log("Cursor native discovery: overlap, credential/endpoint/sign-in-file isolation, an hour's reuse, refresh, failures, the signed-in stage run ahead and production startup reuse passed")
