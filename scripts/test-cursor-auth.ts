import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CURSOR_SDK_AUTH_RETRY_MS,
  CURSOR_SDK_AUTH_TTL_MS,
  CursorSdkAuth,
  rejectionText,
  type CursorSdkProbeClient,
  type CursorSdkSpawnOptions,
} from "../electron/providers/cursor/sdk/auth.ts"
import { CursorSdkError } from "../electron/providers/cursor/sdk/client.ts"
import {
  CursorCredentialStore,
  CursorCredentialStoreError,
  cursorCredentialPath,
  parseCursorApiKey,
  type CursorKeyEncryption,
} from "../electron/providers/cursor/sdk/credentials.ts"
import { authenticationFailure } from "../electron/providers/cursor/sdk/driver.ts"
import { cursorConnection, cursorConnectionState } from "../electron/providers/cursor/connection.ts"
import type { SdkMethod, SdkResult } from "../electron/providers/cursor/sdk/wire.ts"

/**
 * Cursor's SDK sign-in: which key a child runs under, how a pasted or minted
 * key is verified and stored, and what the Settings row is told. Every child
 * here is a fake that answers `me` by the key in its environment, so a key
 * is judged the way Cursor judges it — by the answer, not its shape.
 */

const KEY_GOOD = "key_good_0123456789abcdef"
const KEY_CLI = "key_cli_0123456789abcdef"
const KEY_BAD = "key_bad_0123456789abcdef"
const KEY_MINTED = "key_minted_0123456789abcdef"

const xor: CursorKeyEncryption = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a),
  decrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString("utf8"),
}
const locked: CursorKeyEncryption = {
  available: async () => false,
  encrypt: async () => Buffer.alloc(0),
  decrypt: async () => "",
}

/** The fake child's reply per method; an unlisted method is a test failure. */
type FakeAnswers = { [Method in SdkMethod]?: () => SdkResult<Method> }

interface Fake {
  spawned: string[]
  logins: number
  logouts: number
  sdkFile: "logged-in" | "logged-out"
}

/** A child that knows three keys: good and cli work, bad is refused; without a key the SDK's own file answers. */
function fakeClient(fake: Fake, options: CursorSdkSpawnOptions): CursorSdkProbeClient {
  const key = options.env.CURSOR_API_KEY
  fake.spawned.push(key ?? "<none>")
  const refuse = () =>
    new CursorSdkError({ kind: "authentication", message: "Unauthorized: the API key is invalid or has been revoked", code: "unauthenticated" })
  return {
    hello: async () => ({ wire: 1, sdkVersion: "test", node: process.version }),
    request: async <Method extends SdkMethod>(method: Method): Promise<SdkResult<Method>> => {
      const answers: FakeAnswers = {
        me: () => {
          if (key === KEY_GOOD) return { email: "kash@example.com", apiKeyName: "laptop", createdAt: "2026-09-01T00:00:00Z" }
          if (key === KEY_CLI) return { email: "cli@example.com", apiKeyName: "cursor-agent", createdAt: "2026-09-01T00:00:00Z" }
          if (key === KEY_MINTED) return { email: "kash@example.com", apiKeyName: "Mako", createdAt: "2026-09-13T00:00:00Z" }
          throw refuse()
        },
        authStatus: () =>
          fake.sdkFile === "logged-in" ? { status: "logged-in", email: "file@example.com" } : { status: "logged-out" },
        login: () => {
          fake.logins += 1
          options.onEvent({ event: "login-url", url: "https://cursor.com/loginDeepControl?x=1" })
          return { apiKey: KEY_MINTED, email: "kash@example.com", apiKeyExpiresAtMs: 1_800_000_000_000 }
        },
        logout: () => {
          fake.logouts += 1
          fake.sdkFile = "logged-out"
          return {}
        },
      }
      const answer = answers[method]
      if (!answer) throw new Error(`unexpected ${method}`)
      return answer()
    },
    close: async () => undefined,
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-fixture-cursor-auth-"))
try {
  let clock = 1_000_000
  const opened: string[] = []
  const make = (options: { env?: NodeJS.ProcessEnv; encryption?: CursorKeyEncryption; cliKey?: string | null; fake?: Partial<Fake>; path?: string }) => {
    const fake: Fake = { spawned: [], logins: 0, logouts: 0, sdkFile: "logged-out", ...options.fake }
    const credentials = new CursorCredentialStore(options.path ?? cursorCredentialPath(root), options.encryption ?? xor)
    const auth = new CursorSdkAuth({
      env: async () => options.env ?? {},
      openUrl: async (url) => {
        opened.push(url)
      },
      credentials,
      cliKey: async () => options.cliKey ?? null,
      client: (spawn) => fakeClient(fake, spawn),
      now: () => clock,
    })
    return { auth, fake, credentials }
  }

  // Credentials: shape check before any spawn; encrypted at rest; a locked
  // keychain refuses to save and names the lock when loading.
  assert.equal(parseCursorApiKey(`  ${KEY_GOOD}\n`), KEY_GOOD)
  assert.throws(() => parseCursorApiKey("short"), /whole API key/)
  assert.throws(() => parseCursorApiKey("has spaces in it and is long enough"), /whole API key/)
  {
    const store = new CursorCredentialStore(join(root, "c1.bin"), xor)
    assert.equal(await store.load(), null)
    await store.save({ version: 1, apiKey: KEY_GOOD, method: "pasted", keyName: "laptop", savedAt: "2026-09-13T00:00:00Z" })
    assert.ok(!readFileSync(join(root, "c1.bin")).includes(KEY_GOOD), "the file never holds the key in clear")
    assert.equal((await store.load())?.apiKey, KEY_GOOD)
    await store.clear()
    assert.equal(await store.load(), null)
    const lockedStore = new CursorCredentialStore(join(root, "c1.bin"), locked)
    await assert.rejects(lockedStore.save({ version: 1, apiKey: KEY_GOOD, method: "pasted", savedAt: "" }), CursorCredentialStoreError)
    writeFileSync(join(root, "c2.bin"), "garbage")
    await assert.rejects(new CursorCredentialStore(join(root, "c2.bin"), xor).load(), /could not be opened/)
    await assert.rejects(new CursorCredentialStore(join(root, "c2.bin"), locked).load(), /locked/)
  }

  // Precedence: the host's env first, then Mako's key, then the CLI's, then the SDK's file.
  {
    const { auth, fake } = make({ env: { CURSOR_API_KEY: KEY_GOOD }, cliKey: KEY_CLI })
    const status = await auth.status()
    assert.deepEqual(status.state, { status: "signed-in", source: "env", email: "kash@example.com", keyName: "laptop" })
    assert.equal((await auth.childEnv()).CURSOR_API_KEY, KEY_GOOD)
    assert.equal(fake.spawned.length, 1, "childEnv spawns nothing")
    assert.equal(await auth.status(), status, "a fresh answer is reused")
    clock += CURSOR_SDK_AUTH_TTL_MS
    await auth.status()
    assert.equal(fake.spawned.length, 2, "a stale answer is re-asked")
  }
  {
    const { auth } = make({ cliKey: KEY_CLI })
    assert.deepEqual((await auth.status()).state, { status: "signed-in", source: "cli", email: "cli@example.com", keyName: "cursor-agent" })
    assert.equal((await auth.childEnv()).CURSOR_API_KEY, KEY_CLI, "the CLI's login runs the child")
  }
  {
    const { auth, fake } = make({ fake: { sdkFile: "logged-in" } })
    assert.deepEqual((await auth.status()).state, { status: "signed-in", source: "sdk", email: "file@example.com" })
    assert.equal((await auth.childEnv()).CURSOR_API_KEY, undefined, "the SDK reads its own file")
    assert.deepEqual(fake.spawned, ["<none>"])
  }
  {
    const { auth } = make({})
    assert.deepEqual((await auth.status()).state, { status: "signed-out" })
  }

  // A pasted key is verified before it is saved; a refused one leaves the store untouched.
  {
    const path = join(root, "pasted.bin")
    const { auth, fake, credentials } = make({ path, cliKey: KEY_CLI })
    const changes: string[] = []
    auth.onChange((snapshot) => changes.push(snapshot.state.status === "signed-in" ? snapshot.state.source : "out"))
    await assert.rejects(auth.signInWithKey(KEY_BAD), { name: "CursorSdkError", kind: "authentication" })
    assert.equal(await credentials.load(), null, "a refused key is not saved")
    const signedIn = await auth.signInWithKey(KEY_GOOD)
    assert.deepEqual(signedIn.state, { status: "signed-in", source: "mako", method: "pasted", email: "kash@example.com", keyName: "laptop" })
    assert.equal((await credentials.load())?.apiKey, KEY_GOOD)
    assert.equal((await auth.childEnv()).CURSOR_API_KEY, KEY_GOOD, "Mako's key now outranks the CLI's")
    assert.deepEqual(changes, ["mako"])
    // Sign-out forgets Mako's key and the SDK's file; the CLI's login remains and is reported as such.
    const after = await auth.signOut()
    assert.equal(fake.logouts, 1)
    assert.equal(await credentials.load(), null)
    assert.deepEqual(after.state, { status: "signed-in", source: "cli", email: "cli@example.com", keyName: "cursor-agent" })
    assert.deepEqual(changes, ["mako", "cli"])
  }

  // The browser mint: the URL goes to the host, the minted key to Mako's store, with its expiry.
  {
    const path = join(root, "browser.bin")
    const { auth, fake, credentials } = make({ path })
    const result = await auth.signInWithBrowser()
    assert.equal(fake.logins, 1)
    assert.deepEqual(opened, ["https://cursor.com/loginDeepControl?x=1"])
    assert.deepEqual(result.state, {
      status: "signed-in",
      source: "mako",
      method: "browser",
      email: "kash@example.com",
      keyName: "Mako",
      expiresAt: "2027-01-15T08:00:00.000Z",
    })
    assert.equal((await credentials.load())?.apiKey, KEY_MINTED)
    assert.equal((await auth.childEnv()).CURSOR_API_KEY, KEY_MINTED)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(make({ path: join(root, "aborted.bin") }).auth.signInWithBrowser(controller.signal), /cancelled/)
  }

  // A saved key Cursor no longer accepts: the probe says so, in terms of the source and the fix.
  {
    const path = join(root, "revoked.bin")
    const store = new CursorCredentialStore(path, xor)
    await store.save({ version: 1, apiKey: KEY_BAD, method: "pasted", savedAt: "" })
    const { auth, fake } = make({ path })
    const status = await auth.status()
    assert.equal(status.state.status, "signed-out")
    assert.ok(status.state.status === "signed-out" && status.state.problem?.source === "mako")
    assert.match(status.state.problem.message, /rejected the saved key/)
    assert.equal((await auth.childEnv()).CURSOR_API_KEY, KEY_BAD, "the child still gets the key; the rejection is Cursor's to make")
    await auth.status()
    assert.equal(fake.spawned.length, 1, "a rejection is not re-asked at once")
    clock += CURSOR_SDK_AUTH_RETRY_MS
    await auth.status()
    assert.equal(fake.spawned.length, 2, "…but sooner than a verified answer")
  }
  {
    const { auth } = make({ env: { CURSOR_API_KEY: KEY_BAD } })
    const status = await auth.status()
    assert.ok(status.state.status === "signed-out" && status.state.problem)
    assert.match(status.state.problem.message, /CURSOR_API_KEY/)
    assert.match(rejectionText("cli", "x"), /cursor-agent login/)
  }

  // A saved key this host cannot open is a problem of its own, and the CLI's login still runs.
  {
    const path = join(root, "opaque.bin")
    writeFileSync(path, "not-mako")
    const { auth } = make({ path, cliKey: KEY_CLI })
    const status = await auth.status()
    assert.deepEqual(status.state, { status: "signed-in", source: "cli", email: "cli@example.com", keyName: "cursor-agent" })
    const alone = make({ path }).auth
    const problem = await alone.status()
    assert.ok(problem.state.status === "signed-out" && problem.state.problem?.source === "mako")
    assert.match(problem.state.problem.message, /could not be opened/)
  }

  // A live session's rejection flips the state at once and every listener hears it.
  {
    const { auth } = make({ env: { CURSOR_API_KEY: KEY_GOOD } })
    await auth.status()
    const heard: string[] = []
    auth.onChange((snapshot) => heard.push(snapshot.state.status))
    auth.reportRejected("Unauthorized")
    assert.deepEqual(heard, ["signed-out"])
    assert.equal(auth.signedIn, false)
    assert.ok(authenticationFailure({ message: "x", code: "unauthenticated" }))
    assert.ok(authenticationFailure({ message: "Unauthorized: bad key" }))
    assert.equal(authenticationFailure({ message: "http/2 stream closed" }), false)
    assert.equal(authenticationFailure(undefined), false)
  }

  // The connection capability projects the state without the key, and its actions round-trip.
  {
    const path = join(root, "capability.bin")
    const { auth } = make({ path })
    const capability = cursorConnection(auth, async () => true)
    assert.equal(capability.provider, "cursor")
    assert.equal(await capability.secureStorage(), true)
    const before = await capability.status(false)
    assert.equal(before.status, "signed-out")
    assert.ok(before.checkedAt)
    const keyed = await capability.act({ kind: "sign-in-key", apiKey: KEY_GOOD })
    assert.deepEqual(keyed, { status: "signed-in", source: "mako", method: "pasted", account: "kash@example.com", keyName: "laptop" })
    assert.ok(!JSON.stringify(keyed).includes(KEY_GOOD), "no snapshot carries the key")
    const heard: string[] = []
    const stop = capability.onChange?.(() => heard.push("changed"))
    const out = await capability.act({ kind: "sign-out" })
    assert.deepEqual(out, { status: "signed-out" })
    assert.deepEqual(heard, ["changed"])
    stop?.()
    const projected = cursorConnectionState({ state: { status: "signed-in", source: "env", email: "a@b", expiresAt: "2027-01-01T00:00:00Z" }, checkedAt: 0 })
    assert.deepEqual(projected, { status: "signed-in", source: "env", account: "a@b", expiresAt: "2027-01-01T00:00:00Z" })
  }

  console.log(
    "Cursor auth: env, Mako, CLI and SDK-file keys in that order; pasted keys verified before saving; browser mint stored with expiry; rejections named by source and re-asked sooner; live rejections flip every listener; snapshots never carry the key"
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
