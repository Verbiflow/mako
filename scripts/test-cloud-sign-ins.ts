import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { mock } from "node:test"
import { z } from "zod"
import { claudeCloudSignIn, claudeAccountCapability } from "@mako/host/harnesses/claude/accounts"
import { codexCloudSignIn } from "@mako/host/harnesses/codex/accounts"
import { grokCloudSignIn } from "@mako/host/harnesses/grok/accounts"
import { devinCloudSignIn } from "@mako/host/harnesses/devin/accounts"
import { openCodeChainToken, openCodeCloudSignIn } from "@mako/host/harnesses/opencode/accounts"
import { createCursorAccountCapability } from "@mako/host/harnesses/cursor/accounts"
import { CursorSdkAuth } from "@mako/host/harnesses/cursor/sdk/auth"
import { CursorAccountKeys, CursorCredentialStore } from "@mako/host/harnesses/cursor/sdk/credentials"
import { memorySecrets } from "@mako/host/base/secrets"
import { HarnessAccounts } from "@mako/host/harnesses/accounts"
import { ProviderRegistry } from "@mako/host/harnesses/registry"
import type { ProviderAccountCapability } from "@mako/host/harnesses/account-capability"
import { chainFingerprint, type CloudSignInCapability, type CloudSignInExport, type CloudSignInPayload } from "@mako/host/harnesses/cloud-sign-in"
import { CloudSignInSync, installCloudSignIns } from "@mako/host/harnesses/cloud-sign-ins"
import { CloudSignInSchema, type CloudKeptSignIn, type CloudShareOutcome, type CloudSharedChain, type CloudSignIn, type CloudSignInChain, type CloudSignInHarness, type CloudSignInListing } from "@mako/host/contracts/cloud-sign-ins"
import type { JsonValue } from "@mako/host/contracts/json"

/**
 * Each harness's sign-in read from a Mac's stores, written into a machine's home, and read back from there as the
 * harness reads it: the same sign-in, with no refresh token anywhere on the way. Then the sync that keeps Mako Cloud
 * following the Mac. Fake homes and a stand-in for `security`; no network, no harness runs. Each half runs as
 * the system it stands for, so it reads the Keychain or the files as there, whichever system runs the test.
 */
const securityStandIn = fileURLToPath(new URL("./fixtures/security-stand-in.cjs", import.meta.url))
const root = await mkdtemp(join(os.tmpdir(), "mako-cloud-sign-ins-"))
const mac = join(root, "mac")
const machine = { home: join(root, "machine", "home"), secrets: join(root, "machine", "secrets") }
let home = mac
mock.method(os, "homedir", () => home)
syncBuiltinESMExports()
const original = { ...process.env }
const platform = process.platform
const runAs = (system: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: system, configurable: true })

const jwt = (claims: Record<string, JsonValue>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const hour = 3_600_000
const later = (ms: number) => new Date(Date.now() + ms)
/** Every refresh token and every secret the export must leave behind; none may appear in what's sent or written. */
const REFRESH = ["claude-refresh-secret", "mcp-token-secret", "codex-refresh-secret", "grok-refresh-secret", "opencode-refresh-secret"]

const stores: Record<string, string> = {}
const storePath = join(root, "os-credentials.json")
const saveStore = () => writeFile(storePath, JSON.stringify(stores))

async function write(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, text, { mode: 0o600 })
}

function credentialTable(path: string) {
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)")
  return db
}

const cursorAuth = new CursorSdkAuth({
  env: async () => ({}),
  openUrl: async () => {},
  cliKey: async () => "cursor-cli-key-fixture-0123456789",
  credentials: new CursorCredentialStore(memorySecrets()),
})
const cursor = createCursorAccountCapability(cursorAuth, new CursorAccountKeys(memorySecrets())).cloudSignIn!

const HARNESSES = ["claude", "codex", "cursor", "opencode", "grok", "devin"] as const
type Harness = (typeof HARNESSES)[number]
const adapters = {
  claude: claudeCloudSignIn,
  codex: codexCloudSignIn,
  cursor,
  grok: grokCloudSignIn,
  devin: devinCloudSignIn,
  opencode: openCodeCloudSignIn,
} satisfies Record<Harness, CloudSignInCapability>
const adapterOf = (harness: CloudSignInHarness): CloudSignInCapability => {
  const known = HARNESSES.find((name) => name === harness)
  assert.ok(known, `${harness} is one of this test's harnesses`)
  return adapters[known]
}
const JsonObject = z.record(z.string(), z.json())
const OpenCodeLogins = z.object({ credentials: z.array(z.object({ provider: z.string(), value: z.json() })) })
const CredentialRows = z.array(z.object({ provider: z.string(), value: z.string() }))

try {
  const bin = join(root, "bin")
  await mkdir(bin, { recursive: true })
  await saveStore()
  await writeFile(join(bin, "security"), `#!${process.execPath}
const fs = require('node:fs'), security = require(${JSON.stringify(securityStandIn)}), args = security.command();
const stores = JSON.parse(fs.readFileSync(${JSON.stringify(storePath)}, 'utf8'));
const id = args[args.indexOf('-s')+1];
if (args[0] === 'find-generic-password') { if (!stores[id]) process.exit(44); if (args.includes('-g')) process.stderr.write(security.report(stores[id])); else process.stdout.write(stores[id]); }
else if (args[0] === 'add-generic-password') { if (fs.existsSync(${JSON.stringify(join(root, "refuse-writes"))})) process.exit(1); stores[id] = security.value(args); fs.writeFileSync(${JSON.stringify(storePath)}, JSON.stringify(stores)); }
else process.exit(1);
`, { mode: 0o700 })
  process.env.PATH = `${bin}:${original.PATH ?? ""}`
  for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "GROK_AUTH_PATH", "GROK_HOME", "XDG_DATA_HOME", "OPENCODE_DB", "CURSOR_API_KEY", "HOME"]) delete process.env[key]

  // The Mac: each harness signed in the way it signs itself in.
  runAs("darwin")
  const claudeExpiry = later(8 * hour).getTime()
  stores["Claude Code-credentials"] = JSON.stringify({
    claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh-secret", expiresAt: claudeExpiry, refreshTokenExpiresAt: later(900 * hour).getTime(), scopes: ["user:inference"], subscriptionType: "max" },
    mcpOAuth: { linear: { accessToken: "mcp-token-secret" } },
  })
  await saveStore()
  await write(join(mac, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "claude@example.invalid", accountUuid: "a-1" }, projects: { "/private": {} } }))
  const codexExp = Math.floor(later(240 * hour).getTime() / 1000)
  const codexAccess = jwt({ exp: codexExp })
  await write(join(mac, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: "codex@example.invalid" }), access_token: codexAccess, refresh_token: "codex-refresh-secret", account_id: "acct-1" }, last_refresh: "2026-10-08T02:50:46Z" }))
  const grokExpiry = later(6 * hour).toISOString()
  await write(join(mac, ".grok", "auth.json"), JSON.stringify({ "https://auth.x.ai::client": { key: "grok-key", refresh_token: "grok-refresh-secret", expires_at: grokExpiry, auth_mode: "oidc", email: "grok@example.invalid", oidc_issuer: "https://auth.x.ai" } }))
  await write(join(mac, ".local", "share", "devin", "credentials.toml"), 'windsurf_api_key = "devin-key"\napi_server_url = "https://server.example.invalid"\n')
  const opencodeExpiry = later(240 * hour).getTime()
  const macOpenCode = join(mac, ".local", "share", "opencode", "opencode.db")
  await mkdir(join(macOpenCode, ".."), { recursive: true })
  const macDb = credentialTable(macOpenCode)
  macDb.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)").run("cred_a", "openai", "OpenAI", JSON.stringify({ type: "oauth", methodID: "chatgpt-browser", refresh: "opencode-refresh-secret", access: jwt({ email: "opencode@example.invalid" }), expires: opencodeExpiry, metadata: { accountID: "acct-1" } }))
  macDb.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)").run("cred_b", "google", "Google", JSON.stringify({ type: "key", key: "google-key" }))
  macDb.close()

  // SAFETY: the loop below fills every harness, or fails the test, before any is read.
  const exported = {} as Record<Harness, CloudSignInExport>
  for (const harness of HARNESSES) {
    const signIn = await adapters[harness].export({ ...process.env })
    assert.ok(signIn, `${harness} reads a sign-in`)
    CloudSignInSchema.parse({ harness, ...signIn })
    for (const secret of REFRESH) assert.ok(!JSON.stringify(signIn).includes(secret), `${harness} leaves ${secret} on the Mac`)
    exported[harness] = signIn
  }
  assert.equal(exported.claude.label, "claude@example.invalid")
  assert.equal(exported.claude.expiresAt, new Date(claudeExpiry).toISOString())
  assert.ok(!JSON.stringify(exported.claude).includes("/private"), "Claude's projects stay on the Mac")
  assert.equal(exported.codex.label, "codex@example.invalid")
  assert.equal(exported.codex.expiresAt, new Date(codexExp * 1000).toISOString())
  assert.equal(exported.grok.expiresAt, grokExpiry)
  assert.equal(exported.grok.label, "grok@example.invalid")
  assert.equal(exported.devin.expiresAt, null, "Devin's key doesn't lapse")
  assert.equal(exported.opencode.expiresAt, new Date(opencodeExpiry).toISOString(), "an API key beside a login doesn't hide when the login lapses")
  assert.equal(exported.opencode.label, "opencode@example.invalid")
  assert.equal(exported.cursor.payload.apiKey, "cursor-cli-key-fixture-0123456789")
  console.log("ok  every harness's sign-in is read from the Mac, without a refresh token")

  // The machine: installed by each adapter, read back as the harness reads it, from a home with no keychain item.
  const signIns: CloudSignIn[] = HARNESSES.map((harness) => CloudSignInSchema.parse({ harness, ...exported[harness] }))
  const registry = new ProviderRegistry<ProviderAccountCapability>()
  for (const provider of HARNESSES) registry.register({ ...claudeAccountCapability, provider, cloudSignIn: adapters[provider] })
  const installed = await installCloudSignIns(registry, signIns, machine)
  assert.deepEqual(installed.map((install) => [install.harness, install.status]), signIns.map((signIn) => [signIn.harness, "installed"]))
  delete stores["Claude Code-credentials"]
  await saveStore()
  home = machine.home
  runAs("linux")
  for (const signIn of signIns) {
    const again = await adapterOf(signIn.harness).export({ ...process.env })
    if (signIn.harness === "cursor") {
      assert.equal(again?.payload.apiKey, signIn.payload.apiKey, "Cursor's SDK finds the key in its own file")
      continue
    }
    if (signIn.harness === "opencode") {
      // `auth.json` carries no labels: OpenCode names what it imports.
      const logins = (payload: CloudSignInPayload | undefined) => OpenCodeLogins.parse(payload).credentials
      assert.deepEqual(logins(again?.payload), logins(signIn.payload), "OpenCode imports on the machine the logins the Mac sent")
      continue
    }
    assert.deepEqual(again?.payload, signIn.payload, `${signIn.harness} reads on the machine what the Mac sent`)
  }
  for (const path of [".claude/.credentials.json", ".codex/auth.json", ".grok/auth.json", ".local/share/devin/credentials.toml", ".cursor/sdk/auth.json", ".local/share/opencode/auth.json"]) {
    const link = join(machine.home, path)
    assert.equal(await readlink(link), join(machine.secrets, path), `${path} is linked to the folder in memory`)
    assert.equal((await lstat(join(machine.secrets, path))).mode & 0o777, 0o600, `${path} is the host's alone`)
  }
  const state = JSON.parse(await readFile(join(machine.home, ".claude.json"), "utf8"))
  assert.equal(state.hasCompletedOnboarding, true)
  assert.equal(state.oauthAccount.emailAddress, "claude@example.invalid")
  console.log("ok  each harness reads on the machine the sign-in the Mac sent, kept in memory and linked from home")

  // OpenCode ran and made its database: a later sign-in is written there, where it reads it. It keeps the database
  // open in WAL mode, and its own update of a login large enough to need pages of its own leaves the earlier value
  // in pages it frees.
  const machineDbPath = join(machine.home, ".local", "share", "opencode", "opencode.db")
  const machineDb = credentialTable(machineDbPath)
  machineDb.exec("PRAGMA journal_mode = WAL")
  machineDb.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)").run("cred_old", "openai", "OpenAI", JSON.stringify({ type: "oauth", methodID: "chatgpt-browser", refresh: "", access: `opencode-first-access${"x".repeat(12_000)}`, expires: 1 }))
  machineDb.prepare("UPDATE credential SET value = ? WHERE id = 'cred_old'").run(JSON.stringify({ type: "oauth", methodID: "chatgpt-browser", refresh: "", access: "opencode-own-update", expires: 1 }))
  const opencode = signIns.find((signIn) => signIn.harness === "opencode")!
  await installCloudSignIns(registry, signIns, machine)
  const rows = new DatabaseSync(join(machine.home, ".local", "share", "opencode", "opencode.db"), { readOnly: true })
  const stored = CredentialRows.parse(rows.prepare("SELECT integration_id AS provider, value FROM credential WHERE active = 1 ORDER BY integration_id").all())
  rows.close()
  assert.deepEqual(stored.map((row) => row.provider), ["google", "openai"], "the stale login is replaced, the missing one added")
  const sentOpenAi = OpenCodeLogins.parse(opencode.payload).credentials.find((login) => login.provider === "openai")
  assert.equal(JSON.parse(stored[1]!.value).access, z.object({ access: z.string() }).parse(sentOpenAi?.value).access)
  assert.deepEqual((await openCodeCloudSignIn.export({ ...process.env }))?.payload, opencode.payload)
  console.log("ok  OpenCode's database is written once it has one")

  // The account's set shrinks to Claude: every other harness is signed out on the machine, once.
  const claudeOnly = signIns.filter((signIn) => signIn.harness === "claude")
  const shrunk = await installCloudSignIns(registry, claudeOnly, machine)
  assert.deepEqual(shrunk.map((install) => `${install.harness}:${install.status}`).sort(), ["claude:installed", "codex:removed", "cursor:removed", "devin:removed", "grok:removed", "opencode:removed"])
  for (const harness of ["codex", "devin", "grok", "opencode"] as const) assert.equal(await adapters[harness].export({ ...process.env }), null, `${harness} is signed out on the machine`)
  const onDisk = Buffer.concat(await Promise.all(["", "-wal"].map((suffix) => readFile(`${machineDbPath}${suffix}`).catch(() => Buffer.alloc(0)))))
  const sent = OpenCodeLogins.parse(opencode.payload).credentials.flatMap(({ value }) => {
    const login = z.object({ access: z.string() }).or(z.object({ key: z.string() })).parse(value)
    return "access" in login ? [login.access] : [login.key]
  })
  assert.equal(sent.length, 2)
  for (const token of ["opencode-first-access", "opencode-own-update", ...sent])
    assert.ok(!onDisk.includes(token), `no byte of a removed OpenCode login (${token.slice(0, 12)}…) is left in its database or its log`)
  assert.equal(machineDb.prepare("SELECT count(*) AS n FROM credential").get()?.n, 0, "OpenCode, still running, reads no login")
  machineDb.close()
  // This test's Cursor finds its fixed CLI key anywhere; the file the machine's SDK reads is what goes.
  assert.equal(await lstat(join(machine.home, ".cursor", "sdk", "auth.json")).catch(() => null), null, "Cursor's key is gone from the machine")
  assert.ok(await adapters.claude.export({ ...process.env }), "Claude stays")
  assert.deepEqual((await installCloudSignIns(registry, claudeOnly, machine)).map((install) => install.status), ["installed"], "nothing left to remove")
  console.log("ok  a harness the account no longer shares is signed out on the machine")
  const refused = await installCloudSignIns(registry, [{ harness: "codex", label: null, expiresAt: null, payload: { auth: { tokens: {} } } }], machine)
  assert.equal(refused[0]?.status, "failed", "a sign-in with nothing in it is refused, not written")
  home = mac
  runAs("darwin")

  // OpenCode's logins are one sign-in, named as Mako Cloud names them (the gateway's test pins the same text).
  assert.equal(
    openCodeChainToken({ credentials: [
      { provider: "openai", label: "OpenAI", value: { type: "oauth", refresh: "oa-r", access: "oa-a", expires: 1 } },
      { provider: "google", label: "Google", value: { type: "key", key: "g-k" } },
      { provider: "github-copilot", label: "Copilot", value: { type: "oauth", refresh: "gh", access: "gh", expires: 0 } },
    ] }),
    "github-copilot=gh\ngoogle=g-k\nopenai=oa-r",
  )

  // The sync. Mako Cloud here keeps each rotating sign-in as the gateway does: by fingerprint, with every refresh
  // token the chain has had, refreshing it when told, and answering a share with seeded, adopted, current or stale.
  // Twenty MCP servers' tokens beside the sign-in, as a Claude used every day holds: past what `security -i` reads
  // whole, where a write once saved the item cut short and Claude read it as signed out.
  const servers = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`server-${index}`, { accessToken: "a".repeat(120), refreshToken: "r".repeat(120) }]))
  stores["Claude Code-credentials"] = JSON.stringify({
    claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh-secret", expiresAt: claudeExpiry, scopes: ["user:inference"], subscriptionType: "max" },
    mcpOAuth: { linear: { accessToken: "mcp-token-secret" }, ...servers },
  })
  assert.ok(stores["Claude Code-credentials"].length > 2_100, "past the interactive limit")
  await saveStore()
  await write(join(mac, ".grok", "auth.json"), JSON.stringify({
    "https://auth.x.ai::client": { key: "grok-key", refresh_token: "grok-refresh-secret", expires_at: grokExpiry, email: "grok@example.invalid", oidc_issuer: "https://auth.x.ai", oidc_client_id: "client" },
    "https://other.example::client": { key: "other-key", refresh_token: "other-refresh", oidc_issuer: "https://other.example" },
  }))
  const listed = new Map<CloudSignInHarness, CloudSignIn & { mine: boolean }>()
  const calls: string[] = []
  type Kept = CloudKeptSignIn & { held: string[]; payload: CloudSignInPayload }
  const cloud = new Map<CloudSignInHarness, Kept>()
  const tokenOf = (harness: CloudSignInHarness, payload: CloudSignInPayload) => {
    const token = adapterOf(harness).mirror?.token(payload)
    assert.ok(token, `${harness}'s whole sign-in carries its refresh token`)
    return token
  }
  const shown = (kept: Kept): CloudKeptSignIn => {
    const { held: _held, payload: _payload, ...listing } = kept
    return listing
  }
  let rotations = 0
  /** The cloud's own refresh: a new pair, in the harness's shape, as its provider would answer. */
  const refresh = (harness: CloudSignInHarness) => {
    const kept = cloud.get(harness)!
    rotations += 1
    const token = `${harness}-cloud-refresh-${rotations}`
    const payload = JsonObject.parse(structuredClone(kept.payload))
    if (harness === "claude") payload.oauth = { ...JsonObject.parse(payload.oauth), accessToken: `claude-cloud-access-${rotations}`, refreshToken: token, expiresAt: later(8 * hour).getTime() }
    if (harness === "codex") {
      const auth = JsonObject.parse(payload.auth)
      payload.auth = { ...auth, tokens: { ...JsonObject.parse(auth.tokens), access_token: jwt({ exp: Math.floor(later(240 * hour).getTime() / 1000), n: rotations }), refresh_token: token } }
    }
    if (harness === "opencode")
      payload.credentials = z.array(JsonObject).parse(payload.credentials).map((login) => {
        const value = JsonObject.parse(login.value)
        return login.provider === "openai" ? { ...login, value: { ...value, access: jwt({ email: "opencode@example.invalid", n: rotations }), refresh: token, expires: later(240 * hour).getTime() } } : login
      })
    if (harness === "grok")
      payload.auth = Object.fromEntries(Object.entries(JsonObject.parse(payload.auth)).map(([id, entry]) => [id, { ...JsonObject.parse(entry), key: `grok-cloud-key-${rotations}`, refresh_token: token }]))
    // As the gateway names a sign-in: by its harness's whole token (OpenCode's covers all its logins).
    const fingerprint = chainFingerprint(tokenOf(harness, payload))
    cloud.set(harness, { ...kept, payload, token: fingerprint, held: [...kept.held, fingerprint], refreshedAt: new Date().toISOString() })
    return token
  }
  const store = {
    blocked: async () => undefined,
    list: async () => ({
      signIns: [...listed.values()].map((signIn): CloudSignInListing => ({ harness: signIn.harness, label: signIn.label, expiresAt: signIn.expiresAt, savedAt: "", mine: signIn.mine })),
      kept: [...cloud.values()].map(shown),
    }),
    share: async (harness: CloudSignInHarness, chain: CloudSignInChain): Promise<CloudShareOutcome> => {
      calls.push(`share ${harness}`)
      const token = chainFingerprint(tokenOf(harness, chain.payload))
      const kept = cloud.get(harness)
      if (kept?.token === token) return { outcome: "current", signIn: shown(kept) }
      if (kept?.held.includes(token)) return { outcome: "stale", signIn: shown(kept) }
      const next: Kept = { harness, label: chain.label, state: "connected", expiresAt: null, connectedAt: new Date().toISOString(), refreshedAt: null, problem: null, token, source: "shared", mine: true, held: [...(kept?.held ?? []), token], payload: chain.payload }
      cloud.set(harness, next)
      return { outcome: kept ? "adopted" : "seeded", signIn: shown(next) }
    },
    pull: async (harness: CloudSignInHarness): Promise<CloudSharedChain | null> => {
      calls.push(`pull ${harness}`)
      const kept = cloud.get(harness)
      return kept?.mine && kept.state !== "needs-reconnect" ? { harness, label: kept.label, token: kept.token!, expiresAt: kept.expiresAt, payload: kept.payload } : null
    },
    disconnect: async (harness: CloudSignInHarness) => {
      calls.push(`disconnect ${harness}`)
      cloud.delete(harness)
    },
    put: async (signIn: CloudSignIn) => {
      for (const secret of REFRESH) assert.ok(!JSON.stringify(signIn).includes(secret), "a key sent as it is carries no refresh token")
      calls.push(`put ${signIn.harness}`)
      listed.set(signIn.harness, { ...signIn, mine: true })
    },
    remove: async (harness: CloudSignInHarness) => {
      calls.push(`remove ${harness}`)
      listed.delete(harness)
    },
  }
  const choicePath = join(root, "data", "cloud", "sign-ins.json")
  // An older build's "off" was about sharing access alone; it isn't carried over.
  await write(choicePath, JSON.stringify({ version: 1, sharing: false }))
  const sync = new CloudSignInSync({ accounts: new HarnessAccounts(registry), capabilities: registry, store, dataRoot: join(root, "data"), onChange: () => {} })
  const row = (of: Awaited<ReturnType<typeof sync.check>>, harness: CloudSignInHarness) => of.harnesses.find((entry) => entry.harness === harness)
  const claudeItem = () => JSON.parse(stores["Claude Code-credentials"] ?? "{}")
  const readStores = async () => {
    Object.assign(stores, JSON.parse(await readFile(storePath, "utf8")))
    return {
      claude: claudeItem(),
      codex: JSON.parse(await readFile(join(mac, ".codex", "auth.json"), "utf8")),
      grok: JSON.parse(await readFile(join(mac, ".grok", "auth.json"), "utf8")),
    }
  }

  let synced = await sync.check()
  assert.equal(synced.sharing, true, "sharing is on unless the person turns it off")
  assert.deepEqual(calls.sort(), ["put cursor", "put devin", "share claude", "share codex", "share grok", "share opencode"], "keys go as they are; a rotating sign-in is shared whole")
  for (const harness of ["claude", "codex", "grok", "opencode"] as const) {
    assert.equal(row(synced, harness)?.rotates, true)
    assert.equal(row(synced, harness)?.kept?.state, "connected", `${harness} is one sign-in with the cloud`)
    assert.ok(row(synced, harness)?.inStepAt, `${harness} says when it was last in step`)
  }
  assert.match(JSON.stringify(cloud.get("claude")?.payload), /claude-refresh-secret/, "the cloud refreshes Claude's own sign-in")
  assert.ok(!JSON.stringify(cloud.get("claude")?.payload).includes("mcp-token-secret"), "MCP servers' tokens stay on this Mac")
  assert.deepEqual(Object.keys(JsonObject.parse(cloud.get("grok")?.payload.auth)), ["https://auth.x.ai::client"], "another issuer's Grok sign-in stays here")
  const saved = JSON.parse(await readFile(choicePath, "utf8"))
  assert.equal(saved.version, 2)
  assert.equal(saved.sharing, undefined, "no choice was made, so none is written")
  assert.equal(saved.inStep.codex.token, chainFingerprint("codex-refresh-secret"))
  calls.length = 0
  await sync.check()
  assert.deepEqual([...calls], [], "nothing changed, nothing sent")
  console.log("ok  this Mac's sign-ins seed the cloud: rotating ones whole, keys as they are, with sharing on by default")

  // The cloud refreshes all four while this Mac is away: each pair is written where its harness reads it.
  const cloudTokens = { claude: refresh("claude"), codex: refresh("codex"), grok: refresh("grok"), opencode: refresh("opencode") }
  synced = await sync.check()
  assert.deepEqual(calls.sort(), ["pull claude", "pull codex", "pull grok", "pull opencode"], "the cloud refreshed, so this Mac takes its pairs and sends nothing")
  const openCodeRows = new DatabaseSync(macOpenCode, { readOnly: true })
  const openCodeLogins = CredentialRows.parse(openCodeRows.prepare("SELECT integration_id AS provider, value FROM credential WHERE active = 1 ORDER BY integration_id").all())
  openCodeRows.close()
  assert.equal(JSON.parse(openCodeLogins.find((row) => row.provider === "openai")!.value).refresh, cloudTokens.opencode, "OpenCode's ChatGPT login is written into its own database")
  assert.equal(JSON.parse(openCodeLogins.find((row) => row.provider === "openai")!.value).methodID, "chatgpt-browser")
  assert.deepEqual(JSON.parse(openCodeLogins.find((row) => row.provider === "google")!.value), { type: "key", key: "google-key" }, "a key beside it is kept")
  let local = await readStores()
  assert.equal(local.claude.claudeAiOauth.refreshToken, cloudTokens.claude)
  assert.equal(local.claude.claudeAiOauth.accessToken, cloudTokens.claude.replace("refresh", "access"))
  assert.equal(local.claude.claudeAiOauth.subscriptionType, "max", "Claude's other fields are kept")
  assert.equal(local.claude.mcpOAuth.linear.accessToken, "mcp-token-secret", "MCP servers' tokens beside it are kept")
  assert.deepEqual(local.claude.mcpOAuth["server-19"], servers["server-19"], "a long item is written whole, not cut short")
  assert.equal(local.codex.tokens.refresh_token, cloudTokens.codex)
  assert.equal(local.codex.auth_mode, "chatgpt", "Codex's other fields are kept")
  assert.equal(local.grok["https://auth.x.ai::client"].refresh_token, cloudTokens.grok)
  assert.equal(local.grok["https://other.example::client"].refresh_token, "other-refresh", "another issuer's entry is untouched")
  assert.equal((await lstat(join(mac, ".codex", "auth.json"))).mode & 0o777, 0o600)
  for (const harness of ["claude", "codex", "grok"] as const) assert.equal(row(synced, harness)?.kept?.token, row(synced, harness)?.kept && cloud.get(harness)?.token)
  calls.length = 0
  await sync.check()
  assert.deepEqual([...calls], [], "in step again")
  console.log("ok  each refresh the cloud makes is written into the harness's own store, everything else in it kept")

  // Codex refreshed by itself here: its new pair is newer than anything the cloud has, and is taken.
  local.codex.tokens.refresh_token = "codex-cli-rotated"
  await write(join(mac, ".codex", "auth.json"), JSON.stringify(local.codex))
  calls.length = 0
  await sync.check()
  assert.deepEqual([...calls], ["share codex"])
  assert.equal(cloud.get("codex")?.token, chainFingerprint("codex-cli-rotated"), "the cloud refreshes from the harness's newer pair")
  console.log("ok  a refresh the harness made by itself is sent up and adopted")

  // Behind, then cleared: the cloud refreshed while this Mac slept, Claude refreshed on the token it had, was
  // refused and cleared its store, as Claude does. The cloud's pair is written back.
  const behind = refresh("claude")
  stores["Claude Code-credentials"] = JSON.stringify({ ...claudeItem(), claudeAiOauth: { ...claudeItem().claudeAiOauth, accessToken: "", refreshToken: "", expiresAt: 0 } })
  await saveStore()
  calls.length = 0
  synced = await sync.check()
  assert.deepEqual([...calls], ["pull claude"])
  local = await readStores()
  assert.equal(local.claude.claudeAiOauth.refreshToken, behind, "the sign-in a stale refresh cleared is restored")
  assert.equal(local.claude.mcpOAuth.linear.accessToken, "mcp-token-secret")
  assert.equal(row(synced, "claude")?.status, "sent")
  console.log("ok  a sign-in a stale refresh cleared while this Mac was behind is restored from the cloud")

  // A copy the cloud has moved past, with nothing here to say so (a new install of Mako): the cloud says it's stale.
  const fresh = new CloudSignInSync({ accounts: new HarnessAccounts(registry), capabilities: registry, store, dataRoot: join(root, "fresh"), onChange: () => {} })
  const moved = refresh("grok")
  calls.length = 0
  await fresh.check()
  assert.deepEqual([...calls].filter((call) => call.endsWith("grok")), ["share grok", "pull grok"], "shared, told it's behind, and given the newer pair")
  assert.equal((await readStores()).grok["https://auth.x.ai::client"].refresh_token, moved)
  fresh.stop()
  await sync.check()
  console.log("ok  a copy the cloud has moved past is replaced by the cloud's, never sent over it")

  // Signed out here while in step: the person's choice. The cloud's copy goes too, and nothing is restored.
  await rm(join(mac, ".grok", "auth.json"))
  calls.length = 0
  synced = await sync.check()
  assert.deepEqual([...calls], ["disconnect grok"])
  assert.equal(row(synced, "grok")?.status, "signed-out")
  assert.equal(await lstat(join(mac, ".grok", "auth.json")).catch(() => null), null, "a sign-out here is never undone")
  calls.length = 0
  await sync.check()
  assert.deepEqual([...calls], [])
  console.log("ok  signing out on this Mac signs the cloud out too")

  // Another Mac shares Grok: this one leaves it, and keeps its own sign-in its own.
  await write(join(mac, ".grok", "auth.json"), JSON.stringify({ "https://auth.x.ai::client": { key: "grok-key", refresh_token: "grok-mine", oidc_issuer: "https://auth.x.ai", oidc_client_id: "client" } }))
  cloud.set("grok", { harness: "grok", label: "grok@example.invalid", state: "connected", expiresAt: null, connectedAt: "", refreshedAt: null, problem: null, token: "elsewhere", source: "shared", mine: false, held: ["elsewhere"], payload: {} })
  calls.length = 0
  synced = await sync.check()
  assert.deepEqual([...calls], [], "another Mac's working sign-in is left as it is")
  assert.equal(row(synced, "grok")?.kept?.mine, false)
  cloud.delete("grok")
  console.log("ok  another Mac's shared sign-in is left to that Mac")

  // A write is made only over what was read: the store moved meanwhile, or Claude holds its refresh lock.
  const claudeChain = { label: null, payload: { oauth: { accessToken: "x", refreshToken: "y" }, account: null } }
  const before = stores["Claude Code-credentials"]
  assert.equal(await claudeCloudSignIn.mirror!.write({ ...process.env }, claudeChain, chainFingerprint("not-what-is-there")), false, "a store that moved is left alone")
  const lock = join(mac, ".claude", ".oauth_refresh.lock")
  await mkdir(lock)
  const held = chainFingerprint(claudeItem().claudeAiOauth.refreshToken)
  assert.equal(await claudeCloudSignIn.mirror!.write({ ...process.env }, claudeChain, held), false, "never written while Claude refreshes")
  assert.equal((await readFile(storePath, "utf8")).includes(`"refreshToken":"y"`), false)
  assert.equal(stores["Claude Code-credentials"], before)
  // A lock left by a Claude that died is taken once stale, as proper-lockfile takes it.
  const { utimes } = await import("node:fs/promises")
  await utimes(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
  assert.equal(await claudeCloudSignIn.mirror!.write({ ...process.env }, claudeChain, held), true)
  assert.equal(await lstat(lock).catch(() => null), null, "the lock is released")
  assert.equal(JSON.parse(JSON.parse(await readFile(storePath, "utf8"))["Claude Code-credentials"]).claudeAiOauth.refreshToken, "y")
  console.log("ok  a write lands only over the pair it read, and never while Claude holds its refresh lock")

  // What it costs: the check every minute with nothing changed, and one refresh of the cloud's taken by this Mac.
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
  const steady: number[] = []
  for (let run = 0; run < 15; run += 1) {
    const began = performance.now()
    await sync.check()
    steady.push(performance.now() - began)
  }
  const taken: number[] = []
  for (let run = 0; run < 10; run += 1) {
    refresh("codex")
    const began = performance.now()
    await sync.check()
    taken.push(performance.now() - began)
  }
  console.log(`ok  a check with nothing changed takes ${median(steady).toFixed(1)} ms (median of 15, six harnesses); one taking a cloud refresh ${median(taken).toFixed(1)} ms`)

  // Waking: the network comes back a moment after the Mac, so the check is tried again until the cloud answers, and
  // a harness's launch waits for it (at most five seconds) so it never starts on a pair the cloud moved past.
  let unreachable = 2
  const offline = { ...store, list: async () => (unreachable-- > 0 ? Promise.reject(new Error("offline")) : store.list()) }
  const woken = new CloudSignInSync({ accounts: new HarnessAccounts(registry), capabilities: registry, store: offline, dataRoot: join(root, "woken"), onChange: () => {}, wakeRetryMs: [20, 20, 20] })
  const gated = new HarnessAccounts(registry)
  gated.gateLaunches(() => woken.inStep())
  const wokeAt = performance.now()
  woken.wake()
  const order: string[] = []
  const launched = gated.launch("codex", { ...process.env }).then(() => order.push("launch"))
  const synced2 = gated.launch("codex", { ...process.env }, { trackCredential: false }).then(() => order.push("sync's own read"))
  await Promise.all([launched, synced2])
  assert.deepEqual(order, ["sync's own read", "launch"], "the sync's own reads never wait; a launch waits for the check")
  assert.equal(unreachable, -1, "tried until the cloud answered")
  assert.ok(performance.now() - wokeAt < 2_000)
  await woken.inStep()
  woken.stop()
  console.log("ok  after a wake the check is retried until the cloud answers, and launches wait for it")

  // Overnight: Claude's and Grok's tokens lapsed while the Mac slept, and the cloud held their refresh for its return.
  // Its first read after waking refreshes them (the gateway's `returned`), while each harness refreshes as soon as it
  // reaches its provider. The wake holds each harness's own refresh lock until the cloud's pair is written, so the
  // harness, waiting on the lock as on another of its own processes, reads the new pair under it, never the old.
  await sync.check()
  const overnight = { claude: "", grok: "" }
  let offlineReads = 2
  const returning = {
    ...store,
    list: async () => {
      if (offlineReads-- > 0) throw new Error("offline")
      if (!overnight.claude) overnight.claude = refresh("claude")
      if (!overnight.grok) overnight.grok = refresh("grok")
      return store.list()
    },
  }
  const morning = new CloudSignInSync({ accounts: new HarnessAccounts(registry), capabilities: registry, store: returning, dataRoot: join(root, "data"), onChange: () => {}, wakeRetryMs: [150, 150, 150, 150], wakeHoldMs: 3_000 })
  const claudeLock = join(mac, ".claude", ".oauth_refresh.lock")
  const grokLock = join(mac, ".grok", "auth.json.lock")
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const wokeAt2 = performance.now()
  morning.wake()
  while (!(await lstat(claudeLock).catch(() => null))) await pause(5)
  let holder = ""
  while (!/^\d+:\d+$/.test(holder)) {
    await pause(5)
    holder = await readFile(grokLock, "utf8").catch(() => "")
  }
  assert.doesNotThrow(() => process.kill(Number(holder.split(":")[0]), 0), "Grok's lock names a holder that's alive, as Grok checks")
  // Claude, refreshing as Claude does: its lock first, then its store read again.
  const claudeRefreshes = (async () => {
    for (;;) {
      try {
        await mkdir(claudeLock)
        break
      } catch {
        await pause(10)
      }
    }
    const item = JSON.parse(JSON.parse(await readFile(storePath, "utf8"))["Claude Code-credentials"])
    await rm(claudeLock, { recursive: true, force: true })
    return { token: item.claudeAiOauth.refreshToken, ms: performance.now() - wokeAt2 }
  })()
  // Grok, refreshing as Grok does: an exclusive flock on its lock file, then its auth file read again.
  const grokRefreshes = new Promise<{ token: string; ms: number }>((resolve, reject) => {
    const grok = spawn("/usr/bin/perl", ["-e", 'use Fcntl qw(:flock); use Time::HiRes qw(sleep); open(my $l, "+>>", $ARGV[0]) or exit 2; until (flock($l, LOCK_EX | LOCK_NB)) { sleep 0.01 } $| = 1; print "locked\n"; <STDIN>;', grokLock], { stdio: ["pipe", "pipe", "ignore"] })
    grok.stdout.once("data", async () => {
      const auth = JSON.parse(await readFile(join(mac, ".grok", "auth.json"), "utf8"))
      grok.stdin.end()
      resolve({ token: auth["https://auth.x.ai::client"].refresh_token, ms: performance.now() - wokeAt2 })
    })
    grok.once("error", reject)
  })
  const [claudeAfter, grokAfter] = await Promise.all([claudeRefreshes, grokRefreshes])
  assert.equal(claudeAfter.token, overnight.claude, "Claude reads the cloud's new pair under its lock, never the one the cloud moved past")
  assert.equal(grokAfter.token, overnight.grok, "and so does Grok")
  await morning.inStep()
  assert.ok(offlineReads < 0, "the cloud was reached once the network was back")
  assert.equal(await lstat(claudeLock).catch(() => null), null, "every lock let go")
  console.log(`ok  after an overnight sleep each harness's refresh waits on its own lock and runs on the cloud's new pair: Claude ${claudeAfter.ms.toFixed(0)} ms, Grok ${grokAfter.ms.toFixed(0)} ms after waking, two checks without network included`)

  // A store this Mac can't write: the cloud must never move a pair the Mac can't follow, so a new run proves the
  // write before anything else, and on a refusal takes the sign-in back from the cloud and sends access alone.
  await writeFile(join(root, "refuse-writes"), "")
  const refusing = new CloudSignInSync({ accounts: new HarnessAccounts(registry), capabilities: registry, store, dataRoot: join(root, "data"), onChange: () => {} })
  calls.length = 0
  const refusedState = await refusing.check()
  const claudeRow = row(refusedState, "claude")
  assert.equal(claudeRow?.status, "failed")
  assert.match(claudeRow?.problem ?? "", /can't update this sign-in on this Mac/)
  assert.ok(calls.includes("disconnect claude"), "the cloud stops refreshing what this Mac can't write")
  assert.ok(calls.includes("put claude"), "and gets access alone, as before")
  assert.ok(!cloud.has("claude"))
  assert.ok(!calls.includes("share claude"))
  await rm(join(root, "refuse-writes"))
  const writing = new CloudSignInSync({ accounts: new HarnessAccounts(registry), capabilities: registry, store, dataRoot: join(root, "data"), onChange: () => {} })
  calls.length = 0
  const writingState = await writing.check()
  assert.equal(row(writingState, "claude")?.kept?.state, "connected", "once it writes again, a run shares it again")
  assert.ok(calls.includes("share claude"))
  console.log("ok  a store this Mac can't write is never left to the cloud to move: taken back, and sent as access alone")

  // Off: everything this Mac gave the cloud goes, and the choice is kept.
  calls.length = 0
  synced = await sync.share(false)
  assert.deepEqual([...calls].filter((call) => !call.startsWith("pull") && !call.startsWith("share")).sort(), ["disconnect claude", "disconnect codex", "disconnect grok", "disconnect opencode", "remove cursor", "remove devin"])
  assert.ok(synced.harnesses.every((entry) => entry.status === "waiting" || entry.status === "signed-out"))
  assert.equal(JSON.parse(await readFile(choicePath, "utf8")).sharing, false, "the choice is kept")
  sync.stop()
  console.log("ok  turning sharing off takes back everything this Mac gave the cloud")
} finally {
  runAs(platform)
  process.env = original
  await rm(root, { recursive: true, force: true })
}
