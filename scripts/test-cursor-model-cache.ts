import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCursorModelCache } from "../electron/providers/cursor/sdk/models.ts"
import { createCursorSdkDriver, type CursorSdkLiveClient } from "../electron/providers/cursor/sdk/driver.ts"
import { CursorSdkAuth, type CursorSdkSpawnOptions } from "../electron/providers/cursor/sdk/auth.ts"
import { CursorCredentialStore } from "../electron/providers/cursor/sdk/credentials.ts"
import type { SdkMethod, SdkResult, SdkModelListItem } from "../electron/providers/cursor/sdk/wire.ts"

type FixtureAnswers = { [K in SdkMethod]?: () => SdkResult<K> }

const catalog = (key: string): SdkModelListItem[] => [{ id: key, displayName: key }]
const keyA = { CURSOR_API_KEY: "key_fixture_a_0123456789" }
const keyB = { CURSOR_API_KEY: "key_fixture_b_0123456789" }
let now = 1, calls = 0
const cache = createCursorModelCache(() => now)
let release!: (models: SdkModelListItem[]) => void
const first = cache(keyA, () => { calls++; return new Promise(resolve => { release = resolve }) })
const same = cache({ ...keyA }, async () => { calls++; return catalog("wrong") }, true)
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(calls, 1, "display/startup overlap uses one native list")
const other = await cache(keyB, async () => catalog("B"))
assert.equal(other[0].id, "B", "another credential cannot join the pending account")
release(catalog("A"))
const [a, b] = await Promise.all([first, same])
a[0].displayName = "mutated"
assert.equal(b[0].displayName, "A", "callers cannot mutate one another's model list")
assert.equal((await cache(keyA, async () => catalog("wrong")))[0].id, "A")
assert.equal((await cache(keyA, async () => catalog("fresh"), true))[0].id, "fresh", "display refresh stays native")
assert.equal((await cache({ ...keyA, CURSOR_BACKEND_URL: "https://fixture.invalid" }, async () => catalog("endpoint")))[0].id, "endpoint")
now += 10 * 60_000
assert.equal((await cache(keyA, async () => catalog("expired")))[0].id, "expired")
await assert.rejects(cache(keyA, async () => { throw Error("network fixture") }, true), /network fixture/)
assert.equal((await cache(keyA, async () => catalog("wrong")))[0].id, "expired", "a failed refresh preserves the still-valid native result")
assert.equal((await cache(keyA, async () => catalog("recovered"), true))[0].id, "recovered", "failed refresh requests are not cached")
await assert.rejects(cache(keyA, async () => [], true), /no models/)
assert.equal((await cache(keyA, async () => catalog("nonempty"), true))[0].id, "nonempty")
assert.equal((await cache({}, async () => catalog("native-file-a")))[0].id, "native-file-a")
assert.equal((await cache({}, async () => catalog("native-file-b")))[0].id, "native-file-b", "unresolved mutable SDK credentials cannot reuse a list")

let refreshResult!: (models: SdkModelListItem[]) => void
const refreshing = cache(keyA, () => new Promise(resolve => { refreshResult = resolve }), true)
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal((await cache(keyA, async () => catalog("wrong")))[0].id, "nonempty", "launch cannot wait for display refresh while exact-account evidence is valid")
now += 10 * 60_000
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

const root = await mkdtemp(join(tmpdir(), "mako-cursor-model-cache-"))
let env = keyA
const requests: string[] = []
const client = (options: CursorSdkSpawnOptions): CursorSdkLiveClient => ({
  alive: true, exited: new Promise(() => {}), kill() {}, close: async () => {},
  hello: async () => ({ wire: 1, sdkVersion: "fixture", node: process.version }),
  request: async <M extends SdkMethod>(method: M): Promise<SdkResult<M>> => {
    const answers: FixtureAnswers = {
      me: () => ({ email: "same@example.test", apiKeyName: "same-name", createdAt: "2026-09-25" }),
      models: () => { requests.push(options.env.CURSOR_API_KEY!); return { models: catalog(options.env.CURSOR_API_KEY!) } },
      open: () => ({ agentId: options.owner, model: { id: options.env.CURSOR_API_KEY! } }),
    }
    const answer = answers[method]
    if (!answer) throw Error(`Unexpected ${method}`)
    return answer()
  },
})
const auth = new CursorSdkAuth({
  env: async () => ({ ...env }), cliKey: async () => null, openUrl: async () => { throw Error("no login") }, client,
  credentials: new CursorCredentialStore(join(root, "credentials"), { available: async () => false, encrypt: async () => Buffer.alloc(0), decrypt: async () => "" }),
})
const shared = createCursorModelCache()
const driver = createCursorSdkDriver({ auth, stateRoot: () => root, home: root, client, modelCache: shared })
try {
  // Display discovery fills the same provider-owned cache used by the actual driver.
  await shared(keyA, async () => catalog(keyA.CURSOR_API_KEY), true)
  const a = await driver.start(root, { conversationId: "A", emit() {} })
  assert.equal(a.settings?.model, keyA.CURSOR_API_KEY)
  assert.equal(requests.length, 0, "startup reuses native display discovery")
  env = keyB
  const b = await driver.start(root, { conversationId: "B", emit() {} })
  assert.equal(b.settings?.model, keyB.CURSOR_API_KEY, "same public identity cannot reuse another credential's models")
  assert.deepEqual(requests, [keyB.CURSOR_API_KEY])
  env = keyA
  await driver.start(root, { conversationId: "A2", emit() {} })
  assert.deepEqual(requests, [keyB.CURSOR_API_KEY])
} finally {
  for (const id of ["A", "B", "A2"]) await driver.close(id)
  await rm(root, { recursive: true, force: true })
}
console.log("Cursor native discovery: overlap, credential/endpoint isolation, expiry, refresh, failures and production startup reuse passed")
