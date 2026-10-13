import assert from "node:assert/strict"
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
import { openCodeCloudSignIn } from "@mako/host/harnesses/opencode/accounts"
import { createCursorAccountCapability } from "@mako/host/harnesses/cursor/accounts"
import { CursorSdkAuth } from "@mako/host/harnesses/cursor/sdk/auth"
import { CursorAccountKeys, CursorCredentialStore } from "@mako/host/harnesses/cursor/sdk/credentials"
import { memorySecrets } from "@mako/host/base/secrets"
import { HarnessAccounts } from "@mako/host/harnesses/accounts"
import { ProviderRegistry } from "@mako/host/harnesses/registry"
import type { ProviderAccountCapability } from "@mako/host/harnesses/account-capability"
import type { CloudSignInCapability, CloudSignInExport, CloudSignInPayload } from "@mako/host/harnesses/cloud-sign-in"
import { CloudSignInSync, installCloudSignIns } from "@mako/host/harnesses/cloud-sign-ins"
import { CloudSignInSchema, type CloudSignIn, type CloudSignInHarness, type CloudSignInListing } from "@mako/host/contracts/cloud-sign-ins"
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

  // OpenCode ran and made its database: a later sign-in is written there, where it reads it.
  const machineDb = credentialTable(join(machine.home, ".local", "share", "opencode", "opencode.db"))
  machineDb.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)").run("cred_old", "openai", "OpenAI", JSON.stringify({ type: "oauth", methodID: "chatgpt-browser", refresh: "", access: "stale", expires: 1 }))
  machineDb.close()
  const opencode = signIns.find((signIn) => signIn.harness === "opencode")!
  await installCloudSignIns(registry, signIns, machine)
  const rows = new DatabaseSync(join(machine.home, ".local", "share", "opencode", "opencode.db"), { readOnly: true })
  const stored = CredentialRows.parse(rows.prepare("SELECT integration_id AS provider, value FROM credential WHERE active = 1 ORDER BY integration_id").all())
  rows.close()
  assert.deepEqual(stored.map((row) => row.provider), ["google", "openai"], "the stale login is replaced, the missing one added")
  assert.equal(JSON.parse(stored[1]!.value).access, JSON.parse(JSON.stringify(opencode.payload)).credentials[0].value.access)
  assert.deepEqual((await openCodeCloudSignIn.export({ ...process.env }))?.payload, opencode.payload)
  console.log("ok  OpenCode's database is written once it has one")

  // The account's set shrinks to Claude: every other harness is signed out on the machine, once.
  const claudeOnly = signIns.filter((signIn) => signIn.harness === "claude")
  const shrunk = await installCloudSignIns(registry, claudeOnly, machine)
  assert.deepEqual(shrunk.map((install) => `${install.harness}:${install.status}`).sort(), ["claude:installed", "codex:removed", "cursor:removed", "devin:removed", "grok:removed", "opencode:removed"])
  for (const harness of ["codex", "devin", "grok", "opencode"] as const) assert.equal(await adapters[harness].export({ ...process.env }), null, `${harness} is signed out on the machine`)
  // This test's Cursor finds its fixed CLI key anywhere; the file the machine's SDK reads is what goes.
  assert.equal(await lstat(join(machine.home, ".cursor", "sdk", "auth.json")).catch(() => null), null, "Cursor's key is gone from the machine")
  assert.ok(await adapters.claude.export({ ...process.env }), "Claude stays")
  assert.deepEqual((await installCloudSignIns(registry, claudeOnly, machine)).map((install) => install.status), ["installed"], "nothing left to remove")
  console.log("ok  a harness the account no longer shares is signed out on the machine")
  const refused = await installCloudSignIns(registry, [{ harness: "codex", label: null, expiresAt: null, payload: { auth: { tokens: {} } } }], machine)
  assert.equal(refused[0]?.status, "failed", "a sign-in with nothing in it is refused, not written")
  home = mac
  runAs("darwin")

  // The sync: what the Mac reads goes to the store, once; a change goes again; a sign-out is removed there.
  stores["Claude Code-credentials"] = JSON.stringify({ claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh-secret", expiresAt: claudeExpiry } })
  await saveStore()
  const listed = new Map<CloudSignInHarness, CloudSignIn & { mine: boolean }>([["grok", { ...signIns.find((signIn) => signIn.harness === "grok")!, mine: false }]])
  const calls: string[] = []
  const store = {
    blocked: async () => undefined,
    list: async (): Promise<CloudSignInListing[]> => [...listed.values()].map((signIn) => ({ harness: signIn.harness, label: signIn.label, expiresAt: signIn.expiresAt, savedAt: "", mine: signIn.mine })),
    put: async (signIn: CloudSignIn) => {
      for (const secret of REFRESH) assert.ok(!JSON.stringify(signIn).includes(secret))
      calls.push(`put ${signIn.harness}`)
      listed.set(signIn.harness, { ...signIn, mine: true })
    },
    remove: async (harness: CloudSignInHarness) => {
      calls.push(`remove ${harness}`)
      listed.delete(harness)
    },
  }
  const sync = new CloudSignInSync({ accounts: new HarnessAccounts(registry), capabilities: registry, store, dataRoot: join(root, "data"), onChange: () => {} })
  let shown = await sync.share(true)
  sync.stop()
  assert.deepEqual(calls.sort(), signIns.map((signIn) => `put ${signIn.harness}`).sort())
  assert.ok(shown.harnesses.every((row) => row.status === "sent" && row.sentAt), "every row says it was sent")
  calls.length = 0
  await sync.check()
  assert.deepEqual(calls, [], "nothing changed, nothing sent")
  await write(join(mac, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: jwt({ email: "codex@example.invalid" }), access_token: jwt({ exp: Math.floor(later(241 * hour).getTime() / 1000) }), refresh_token: "codex-refresh-secret", account_id: "acct-1" } }))
  await rm(join(mac, ".grok", "auth.json"))
  shown = await sync.check()
  assert.deepEqual(calls.sort(), ["put codex", "remove grok"], "Codex refreshed here is sent again; Grok signed out here is removed there")
  assert.equal(shown.harnesses.find((row) => row.harness === "grok")?.status, "signed-out")
  calls.length = 0
  listed.set("devin", { ...listed.get("devin")!, mine: false })
  shown = await sync.share(false)
  assert.deepEqual(calls.sort(), ["remove claude", "remove codex", "remove cursor", "remove opencode"], "turning sharing off removes only what this Mac sent")
  assert.ok(shown.harnesses.every((row) => row.status === "waiting" || row.status === "signed-out"))
  assert.equal(JSON.parse(await readFile(join(root, "data", "cloud", "sign-ins.json"), "utf8")).sharing, false, "the choice is kept")
  console.log("ok  the sync sends each sign-in once, again when it changes, removes one signed out, and stops when told")
} finally {
  runAs(platform)
  process.env = original
  await rm(root, { recursive: true, force: true })
}
