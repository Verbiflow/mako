import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import { mock } from "node:test"
import { parse } from "smol-toml"
import { z } from "zod"
import { assertAccountLaunch, captureAccount, resolveAccountLaunch, selectAccount } from "../electron/accounts.ts"
import { cancelAccountLogin, startAccountLogin, submitAccountLoginCode, waitAccountLogin } from "../electron/account-login.ts"
import { accountDir } from "../electron/accounts-common.ts"
import { claudeAccountCapability as claude } from "../electron/providers/claude/accounts.ts"
import { codexAccountCapability as codex } from "../electron/providers/codex/accounts.ts"
import { grokAccountCapability as grok } from "../electron/providers/grok/accounts.ts"
import { devinAccountCapability as devin } from "../electron/providers/devin/accounts.ts"
import { openCodeAccountCapability as opencode } from "../electron/providers/opencode/accounts.ts"
import { cursorAccountCapability } from "../electron/providers/cursor/accounts.ts"
import { CURSOR_ACCOUNT_ENV, CursorSdkAuth, type CursorSdkProbeClient } from "../electron/providers/cursor/sdk/auth.ts"
import type { SdkMethod, SdkResult } from "../electron/providers/cursor/sdk/wire.ts"
import { CursorAccountKeys, CursorCredentialStore, type StoredCursorCredential } from "../electron/providers/cursor/sdk/credentials.ts"
import { memorySecrets } from "../electron/secrets.ts"
import { codexModelProvider, managedCodexConfig, readCodexCredentials } from "../electron/providers/codex/credentials.ts"

const securityStandIn = fileURLToPath(new URL("./fixtures/security-stand-in.cjs", import.meta.url))

/** The fake Cursor SDK child's reply per method; an unlisted method is a test failure. */
type CursorAnswers = { [Method in SdkMethod]?: () => SdkResult<Method> }

// Real facade/adapters, private homes and fake OS credential store. No native login or network.
const root = await mkdtemp(join(os.tmpdir(), "mako-account 'profiles-"))
const original = { ...process.env }
mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
const claudeCredential = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token } })
const codexCredential = (token: string, account = "account-native") => JSON.stringify({ tokens: { access_token: token, account_id: account } })
const stores: Record<string, string> = {}
const storePath = join(root, "os-credentials.json")
const saveStore = () => writeFile(storePath, JSON.stringify(stores))
try {
  const bin = join(root, "bin")
  await mkdir(bin)
  await saveStore()
  await writeFile(join(bin, "security"), `#!${process.execPath}
const fs = require('node:fs'), security = require(${JSON.stringify(securityStandIn)}), args = security.command();
const file = ${JSON.stringify(storePath)}, stores = JSON.parse(fs.readFileSync(file, 'utf8'));
const get = key => args[args.indexOf(key)+1];
const id = get('-s') === 'Codex Auth' ? get('-s')+'|'+get('-a') : get('-s');
if (process.env.MAKO_FIXTURE_KEYCHAIN_DENIED === '1') { process.stderr.write(security.report('fixture-credential-must-stay-private')); process.exit(36); }
if (args[0] === 'find-generic-password') { if (!stores[id]) process.exit(44); if (args.includes('-g')) process.stderr.write(security.report(stores[id])); }
else if (args[0] === 'add-generic-password') { stores[id] = security.value(args); fs.writeFileSync(file, JSON.stringify(stores)); }
else if (args[0] === 'delete-generic-password') { delete stores[id]; fs.writeFileSync(file, JSON.stringify(stores)); }
else process.exit(1);
`, { mode: 0o700 })
  process.env.PATH = `${bin}:${original.PATH ?? ""}`
  for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete process.env[key]
  const nativeClaude = join(root, ".claude"), nativeCodex = join(root, ".codex")
  await mkdir(join(nativeClaude, "projects"), { recursive: true })
  await mkdir(join(nativeCodex, "sessions"), { recursive: true })
  await writeFile(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "native@example.invalid" } }))
  await writeFile(join(nativeClaude, ".credentials.json"), claudeCredential("native-claude"))
  stores["Claude Code-credentials"] = claudeCredential("native-claude")
  await saveStore()
  await writeFile(join(nativeCodex, "auth.json"), JSON.stringify({ tokens: { access_token: "native-codex", account_id: "account-native", id_token: `e30.${Buffer.from(JSON.stringify({ email: "native@example.invalid" })).toString("base64url")}.fixture` } }))
  for (const capability of [claude, codex]) {
    const listed = await capability.listAccounts(null)
    assert.equal(listed.length, 1, "the CLI's ordinary login is the one account a new install has")
    assert.equal(listed[0]?.route, "native")
    assert.equal(listed[0]?.active, true)
  }

  // A shell that exports another config home, an API key and another backend
  // changes nothing: Mako's default is the ordinary login a terminal signs in to.
  const elsewhere = join(root, "elsewhere")
  await mkdir(elsewhere)
  await writeFile(join(elsewhere, ".credentials.json"), claudeCredential("elsewhere-claude"))
  await writeFile(join(elsewhere, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "elsewhere@example.invalid" } }))
  await writeFile(join(elsewhere, "auth.json"), codexCredential("elsewhere-codex"))
  process.env.CLAUDE_CONFIG_DIR = elsewhere
  process.env.CODEX_HOME = elsewhere
  process.env.ANTHROPIC_API_KEY = "wrong-api-identity"
  process.env.OPENAI_API_KEY = "wrong-api-identity"
  process.env.ANTHROPIC_BASE_URL = "https://fixture.invalid"
  process.env.OPENAI_BASE_URL = "https://fixture.invalid"
  process.env.CLAUDE_CODE_USE_BEDROCK = "1"
  // Fake CLIs: `login` prints its sign-in page, then signs the profile in as
  // FIXTURE_LOGIN_EMAIL, waits for a pasted code, hangs, or fails, as
  // FIXTURE_LOGIN_MODE says; `status` succeeds once the profile has credentials.
  for (const program of ["claude", "codex"]) {
    await writeFile(join(bin, program), `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const program=${JSON.stringify(program)}, dir=process.env[program==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME'];
const args=process.argv.slice(2), credentials=path.join(dir||'', program==='claude'?'.credentials.json':'auth.json');
if (args.includes('status')) process.exit(dir && fs.existsSync(credentials) ? 0 : 1);
if (!dir || process.env[program==='claude'?'ANTHROPIC_API_KEY':'OPENAI_API_KEY']) process.exit(2);
const email=process.env.FIXTURE_LOGIN_EMAIL||'separate@example.invalid', mode=process.env.FIXTURE_LOGIN_MODE||'browser';
const signIn=() => {
if (program==='claude') {
const raw=JSON.stringify({claudeAiOauth:{accessToken:'independent-native-login'}});
fs.writeFileSync(credentials,raw);
fs.writeFileSync(path.join(dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:email}}));
const file=${JSON.stringify(storePath)}, stores=JSON.parse(fs.readFileSync(file,'utf8'));
stores['Claude Code-credentials-'+crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0,8)]=raw;
fs.writeFileSync(file,JSON.stringify(stores));
} else fs.writeFileSync(credentials,JSON.stringify({tokens:{access_token:'independent-native-login',id_token:'e30.'+Buffer.from(JSON.stringify({email})).toString('base64url')+'.fixture'}}));
};
process.stdout.write('Opening \\u001b[1mhttps://sign-in.example.invalid/' + program + '?state=fixture\\u001b[0m\\n');
if (mode==='fail') process.exit(1);
if (mode==='hang') setInterval(() => {}, 1000);
else if (mode==='code') process.stdin.once('data', chunk => { if (String(chunk).trim()!=='fixture-code') process.exit(1); signIn(); process.exit(0); });
else signIn();
`, { mode: 0o700 })
  }
  const loginEnv = (mode?: string, email?: string) => {
    if (mode) process.env.FIXTURE_LOGIN_MODE = mode
    else delete process.env.FIXTURE_LOGIN_MODE
    if (email) process.env.FIXTURE_LOGIN_EMAIL = email
    else delete process.env.FIXTURE_LOGIN_EMAIL
  }
  const managedNames = async (capability: typeof claude | typeof codex) =>
    (await capability.listAccounts(null)).filter(account => account.source === "mako").map(account => account.name)
  const managedDirs = async (provider: string) =>
    (await readdir(join(root, ".mako", "accounts", provider)).catch((): string[] => [])).filter(name => name.startsWith("account-"))
  for (const capability of [claude, codex]) {
    process.env[capability.provider === "claude" ? "CLAUDE_CODE_EXECUTABLE" : "CODEX_EXECUTABLE"] = join(bin, capability.provider)
    const filename = capability.provider === "claude" ? ".credentials.json" : "auth.json"

    loginEnv("hang")
    const pending = await startAccountLogin(capability.provider)
    assert.equal(pending.url, `https://sign-in.example.invalid/${capability.provider}?state=fixture`, "the card gets the CLI's sign-in page without terminal styling")
    assert.equal(pending.paste, capability.provider === "claude" ? "code" : undefined)
    assert.equal(pending.openPage, false, "the CLI opens its own page")
    assert.equal(pending.renew, undefined)
    const [pendingName] = await managedDirs(capability.provider)
    assert.ok(pendingName, "the profile exists while the CLI signs it in")
    await assert.rejects(readFile(join(accountDir(capability.provider, pendingName), filename)), { code: "ENOENT" }, "preparing a login never copies another account's credentials")
    assert.deepEqual(await managedNames(capability), [], "an unfinished sign-in is never listed or selectable")
    await cancelAccountLogin(pending.id)
    assert.deepEqual(await waitAccountLogin(pending.id), { status: "cancelled" })
    assert.deepEqual(await managedDirs(capability.provider), [], "cancelling removes the half-made profile")

    loginEnv("fail")
    await assert.rejects(startAccountLogin(capability.provider).then(login => waitAccountLogin(login.id)), /didn't finish/, "a failed CLI login is not an account")
    assert.deepEqual(await managedDirs(capability.provider), [], "a failed sign-in leaves no profile")

    loginEnv(capability.provider === "claude" ? "code" : undefined)
    const login = await startAccountLogin(capability.provider)
    if (capability.provider === "claude") {
      assert.throws(() => submitAccountLoginCode(login.id, "two words"), /whole code/)
      submitAccountLoginCode(login.id, " fixture-code ")
    } else assert.throws(() => submitAccountLoginCode(login.id, "fixture-code"), /doesn't take/)
    const added = await waitAccountLogin(login.id)
    assert.equal(added.status, "added")
    assert.ok(added.status === "added" && added.email === "separate@example.invalid")
    const name = added.status === "added" ? added.name : ""
    const dir = accountDir(capability.provider, name)
    assert.deepEqual(await managedNames(capability), [name], "a finished sign-in is listed once its status check passes")
    const env = await capability.accountEnv(name, process.env)
    assert.equal(env[capability.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"], dir)
    assert.match(await readFile(join(dir, filename), "utf8"), /independent-native-login/)
    assert.equal(await realpath(join(dir, capability.provider === "claude" ? "projects" : "sessions")), await realpath(join(capability.provider === "claude" ? nativeClaude : nativeCodex, capability.provider === "claude" ? "projects" : "sessions")), "shell routing changes cannot move the managed profile's store origin")

    if (capability.provider === "claude") {
      loginEnv(undefined, "separate@example.invalid")
      const again = await startAccountLogin("claude")
      assert.deepEqual(await waitAccountLogin(again.id), { status: "duplicate", name, email: "separate@example.invalid" }, "signing the same account in twice keeps one")
      assert.deepEqual(await managedDirs("claude"), [name])
    }

    // The login expires: the profile stays, and signing in again restores it in place.
    await rm(join(dir, filename))
    if (capability.provider === "claude") {
      const saved = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(storePath, "utf8")))
      for (const service of Object.keys(saved)) if (service.startsWith("Claude Code-credentials-")) delete saved[service]
      await writeFile(storePath, JSON.stringify(saved))
    }
    await assert.rejects(capability.accountEnv(name, process.env), /signed out/, "a signed-out account refuses new sessions instead of borrowing another login")
    loginEnv("fail")
    await assert.rejects(startAccountLogin(capability.provider, name).then(login => waitAccountLogin(login.id)), /didn't finish/)
    assert.deepEqual(await managedDirs(capability.provider), [name], "a failed renewal keeps the account")
    loginEnv(undefined, "separate@example.invalid")
    const renewal = await startAccountLogin(capability.provider, name)
    assert.equal(renewal.renew, name)
    assert.deepEqual(await waitAccountLogin(renewal.id), { status: "renewed", name, email: "separate@example.invalid" })
    assert.match(await readFile(join(dir, filename), "utf8"), /independent-native-login/)
    assert.equal((await capability.accountEnv(name, process.env))[capability.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"], dir)
    loginEnv(undefined, "someone-else@example.invalid")
    const switched = await startAccountLogin(capability.provider, name)
    assert.deepEqual(await waitAccountLogin(switched.id), { status: "renewed", name, email: "someone-else@example.invalid", previousEmail: "separate@example.invalid" }, "a renewal as someone else says so")
    loginEnv(undefined, "separate@example.invalid")
    await waitAccountLogin((await startAccountLogin(capability.provider, name)).id)
    await assert.rejects(startAccountLogin(capability.provider, "default"), /isn't one Mako keeps/, "the CLI's own login is not signed in again from Mako")
  }
  loginEnv()
  for (const capability of [claude, codex]) {
    const own = (await capability.listAccounts(null)).filter(account => account.source === "cli")
    assert.equal(own.length, 1, "the CLI's login is one row")
    assert.equal(own[0]?.name, "default")
    assert.equal(own[0]?.route, "native")
    assert.equal(own[0]?.email, "native@example.invalid", "the default is the ordinary login, not the config home the shell exported")
    assert.equal(own[0]?.dir, capability.provider === "claude" ? nativeClaude : nativeCodex)
    await selectAccount(capability.provider, null)
    const launch = await resolveAccountLaunch(capability.provider, process.env)
    assert.equal(launch.account.name, "default")
    assert.equal(launch.account.dir, capability.provider === "claude" ? nativeClaude : nativeCodex)
    assert.equal(launch.env[capability.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"], undefined)
    assert.equal(launch.env[capability.provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"], undefined)
    assert.equal(launch.env[capability.provider === "claude" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"], undefined)
    await assertAccountLaunch(capability.provider, launch)
    await captureAccount(capability.provider, "personal")
    const saved = accountDir(capability.provider, "personal")
    const filename = capability.provider === "claude" ? ".credentials.json" : "auth.json"
    assert.match(await readFile(join(saved, filename), "utf8"), /native-/)
    await selectAccount(capability.provider, "personal")
    const managed = await resolveAccountLaunch(capability.provider, process.env)
    assert.equal(managed.account.name, "personal")
    assert.equal(managed.env[capability.provider === "claude" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"], undefined)
    assert.equal((await capability.listAccounts("personal")).filter(account => account.active).length, 1)
    const service = `Claude Code-credentials-${createHash("sha256").update(saved.normalize("NFC")).digest("hex").slice(0, 8)}`
    const write = async (contents: string) => {
      await writeFile(join(saved, filename), contents)
      if (capability.provider === "claude") {
        stores[service] = contents
        await saveStore()
      }
    }
    await write(capability.provider === "claude" ? claudeCredential("rotated") : codexCredential("rotated"))
    await assertAccountLaunch(capability.provider, managed)
    const replacement = capability.provider === "claude" ? claudeCredential("another") : codexCredential("another", "account-other")
    await write(replacement)
    if (capability.provider === "claude")
      await writeFile(join(saved, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "account-other", emailAddress: "other@example.invalid" } }))
    await assert.rejects(assertAccountLaunch(capability.provider, managed), /credentials changed/, "another login in the account's place is refused")
    await capability.accountEnv("personal", process.env)
    assert.equal(await readFile(join(saved, filename), "utf8"), replacement, "routing never overwrites native refreshes with a stale source copy")
    await selectAccount(capability.provider, null)
  }

  // The default's revision follows the ordinary login; another config home in the launch env is not it.
  for (const capability of [claude, codex]) {
    const env = { PATH: process.env.PATH, [capability.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: elsewhere }
    const launch = await resolveAccountLaunch(capability.provider, env)
    const filename = capability.provider === "claude" ? ".credentials.json" : "auth.json"
    await writeFile(join(elsewhere, filename), capability.provider === "claude" ? claudeCredential("elsewhere-rotated") : codexCredential("elsewhere-rotated"))
    await assertAccountLaunch(capability.provider, launch)
    if (capability.provider === "claude") {
      stores["Claude Code-credentials"] = claudeCredential("native-rotated")
      await saveStore()
    } else await writeFile(join(nativeCodex, "auth.json"), codexCredential("native-rotated"))
    await assertAccountLaunch(capability.provider, launch)
    if (capability.provider === "claude")
      await writeFile(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "native-other", emailAddress: "native@example.invalid" } }))
    else await writeFile(join(nativeCodex, "auth.json"), codexCredential("native-rotated", "account-other"))
    await assert.rejects(assertAccountLaunch(capability.provider, launch), /credentials changed/)
  }

  for (const [capability, relative, env] of [
    [grok, "grok-auth.json", { GROK_AUTH_PATH: join(root, "grok-auth.json") }],
    [devin, "devin/credentials.toml", { XDG_DATA_HOME: root }],
    [opencode, "opencode/auth.json", { XDG_DATA_HOME: root }],
  ] as const) {
    const path = join(root, relative)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "one")
    const launch = await resolveAccountLaunch(capability.provider, env)
    await writeFile(path, "two")
    await assert.rejects(assertAccountLaunch(capability.provider, launch), /credentials changed/)
  }

  // A CLI refreshing its own login is the same account: the next prompt goes. Another account in its place does not.
  const refreshes = [
    [grok, "grok-auth.json", { GROK_AUTH_PATH: join(root, "grok-auth.json") },
      (token: string, user = "user-1") => JSON.stringify({ "https://auth.x.ai::id": { key: token, refresh_token: `${token}-refresh`, expires_at: token, user_id: user, team_id: "team", auth_mode: "oidc" } })],
    [opencode, "opencode/auth.json", { XDG_DATA_HOME: root },
      (token: string, user = "user-1") => JSON.stringify({ openai: { type: "oauth", access: token, refresh: `${token}-refresh`, expires: 1, accountId: user } })],
  ] as const
  for (const [capability, relative, env, login] of refreshes) {
    const path = join(root, relative)
    await writeFile(path, login("first"))
    const launch = await resolveAccountLaunch(capability.provider, env)
    await writeFile(path, login("refreshed"))
    await assertAccountLaunch(capability.provider, launch)
    await writeFile(path, login("refreshed", "user-2"))
    await assert.rejects(assertAccountLaunch(capability.provider, launch), /credentials changed/, `${capability.provider}: another account is refused`)
  }
  const cursorSecrets = memorySecrets()
  const cursorKeys = new CursorAccountKeys(cursorSecrets)
  const cursorAuth = new CursorSdkAuth({
    env: async () => ({ CURSOR_API_KEY: "global-fixture-key" }), openUrl: async () => {}, cliKey: async () => null,
    credentials: new CursorCredentialStore(cursorSecrets),
    client: (options): CursorSdkProbeClient => ({
      hello: async () => ({ wire: 1, sdkVersion: "fixture", node: process.version }),
      close: async () => undefined,
      request: async <Method extends SdkMethod>(method: Method): Promise<SdkResult<Method>> => {
        const answers: CursorAnswers = {
          me: () => ({ email: "cursor-default@example.invalid", apiKeyName: "fixture", createdAt: "2026-10-01T00:00:00Z" }),
          login: () => {
            options.onEvent({ event: "login-url", url: "https://cursor.example.invalid/login?challenge=fixture" })
            return { apiKey: "cursor_account_fixture_key", email: "cursor-added@example.invalid", apiKeyExpiresAtMs: Date.now() + 86_400_000 }
          },
        }
        const answer = answers[method]
        if (!answer) throw new Error(`unexpected ${method}`)
        return answer()
      },
    }),
  })
  const cursor = cursorAccountCapability(cursorAuth, cursorKeys)
  const cursorExplicit = await cursor.credentialRevision("default", { CURSOR_API_KEY: "explicit-fixture-key" })
  assert.notEqual(cursorExplicit, await cursor.credentialRevision("default"), "Cursor uses the supplied launch key, not its host's global key")
  assert.equal(cursorExplicit, await cursor.credentialRevision("default", { CURSOR_API_KEY: "explicit-fixture-key" }))
  const sdkAuthPath = join(root, ".cursor", "sdk", "auth.json")
  await mkdir(join(sdkAuthPath, ".."), { recursive: true })
  await writeFile(sdkAuthPath, "one")
  const sdkRevision = await cursor.credentialRevision("default", { HOME: root })
  await writeFile(sdkAuthPath, "two")
  assert.notEqual(sdkRevision, await cursor.credentialRevision("default", { HOME: root }), "SDK-owned credentials also invalidate warm admission")

  // Cursor: the SDK mints a key per account added, each kept in its own record.
  assert.ok(cursor.nativeLogin)
  const cursorLaunch = await cursor.prepareAccountLogin({ name: "account-cursor1", renew: false })
  assert.equal(cursorLaunch.kind, "task")
  if (cursorLaunch.kind !== "task") throw new Error("Cursor signs in through its SDK")
  const cursorPages: string[] = []
  await cursorLaunch.run({ page: (url) => cursorPages.push(url) }, new AbortController().signal)
  assert.deepEqual(cursorPages, ["https://cursor.example.invalid/login?challenge=fixture"], "the window is told the SDK's page to open")
  const cursorAdded = (await cursor.listAccounts("account-cursor1")).find(account => account.name === "account-cursor1")
  assert.equal(cursorAdded?.email, "cursor-added@example.invalid")
  assert.equal(cursorAdded?.active, true)
  assert.equal(cursorAdded?.signedOut, undefined)
  const cursorEnv = await cursor.accountEnv("account-cursor1", { CURSOR_API_KEY: "global-fixture-key" })
  assert.equal(cursorEnv.CURSOR_API_KEY, "cursor_account_fixture_key", "the selected account's key replaces the inherited one")
  assert.equal(cursorEnv[CURSOR_ACCOUNT_ENV], "account-cursor1")
  const cursorCredential = (await cursorAuth.childLaunch(cursorEnv)).credential
  assert.equal(cursorCredential.kind === "configured" ? cursorCredential.source : undefined, "account")
  assert.equal((await cursor.listAccounts(null)).find(account => account.name === "default")?.email, "cursor-default@example.invalid", "Cursor's own login keeps its row")
  const stored = await cursorKeys.store("account-cursor1").load()
  assert.ok(stored)
  await cursorKeys.store("account-cursor1").save({ ...stored, expiresAt: new Date(Date.now() - 1_000).toISOString() })
  assert.equal((await cursor.listAccounts(null)).find(account => account.name === "account-cursor1")?.signedOut, true, "an expired key shows as signed out")
  await assert.rejects(cursor.accountEnv("account-cursor1", {}), /expired/)
  assert.deepEqual(await cursor.accountUsage("account-cursor1"), { status: "missing-credentials" })
  const realFetch = globalThis.fetch
  const cursorCalls: string[] = []
  globalThis.fetch = async (input) => { cursorCalls.push(String(input)); throw new Error("an expired key needs no network") }
  try {
    assert.deepEqual(await cursor.removeAccount("account-cursor1"), {}, "an expired key is already dead at Cursor")
  } finally { globalThis.fetch = realFetch }
  assert.deepEqual(cursorCalls, [])
  assert.deepEqual(await cursorKeys.names(), [])

  // Removing an account revokes the key Mako minted for it, found by its
  // name, exact expiry and masked ends, and says plainly when it couldn't.
  const mintedKey = "crsr_ab0123456789minted9xyz"
  const mintedExpiry = Date.now() + 30 * 86_400_000
  interface ListedKey { id: number; maskedKey: string; name: string; expiresAt?: string }
  interface CursorFixture { exchange: number; revoke: number; offline: boolean; keys: ListedKey[]; revoked: number[]; bearers: string[] }
  const cursorFixture: CursorFixture = { exchange: 200, revoke: 200, offline: false, keys: [], revoked: [], bearers: [] }
  const listedKeys = (extra: ListedKey[] = []): ListedKey[] => [
    { id: 7, maskedKey: "crsr_ab...9xyz", name: "Mako", expiresAt: String(mintedExpiry) },
    { id: 8, maskedKey: "crsr_zz...0000", name: "Mako", expiresAt: String(mintedExpiry) },
    { id: 9, maskedKey: "crsr_ab...9xyz", name: "Mako", expiresAt: String(mintedExpiry + 1) },
    { id: 10, maskedKey: "crsr_ab...9xyz", name: "laptop", expiresAt: String(mintedExpiry) },
    ...extra,
  ]
  const sessionJwt = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.fixture`
  const cursorStandIn: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const bearer = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? ""
    cursorFixture.bearers.push(`${url.pathname} ${bearer === mintedKey ? "key" : bearer === sessionJwt ? "session" : "other"}`)
    if (cursorFixture.offline) throw new TypeError("fetch failed")
    if (url.pathname === "/auth/exchange_user_api_key")
      return cursorFixture.exchange === 200 ? Response.json({ accessToken: sessionJwt }) : new Response("{}", { status: cursorFixture.exchange })
    if (url.pathname === "/aiserver.v1.DashboardService/ListUserApiKeys") return Response.json({ apiKeys: cursorFixture.keys })
    if (url.pathname === "/aiserver.v1.DashboardService/RevokeUserApiKey") {
      if (cursorFixture.revoke !== 200) return new Response("{}", { status: cursorFixture.revoke })
      cursorFixture.revoked.push(z.object({ id: z.number() }).parse(JSON.parse(String(init?.body))).id)
      return Response.json({})
    }
    return new Response("{}", { status: 404 })
  }
  const removeMinted = async (setup: Partial<Omit<CursorFixture, "revoked" | "bearers">>, credential: Partial<StoredCursorCredential> = {}) => {
    Object.assign(cursorFixture, { exchange: 200, revoke: 200, offline: false, keys: listedKeys(), revoked: [], bearers: [] }, setup)
    await cursorKeys.store("account-revoke").save({
      version: 1, apiKey: mintedKey, method: "browser", keyName: "Mako", email: "cursor-added@example.invalid",
      expiresAt: new Date(mintedExpiry).toISOString(), savedAt: new Date().toISOString(), ...credential,
    })
    globalThis.fetch = cursorStandIn
    try {
      const removal = await cursor.removeAccount("account-revoke")
      assert.deepEqual(await cursorKeys.names(), [], "the account is gone here whatever Cursor said")
      assert.ok(!JSON.stringify(removal).includes(mintedKey), "a removal never repeats the key")
      return removal
    } finally { globalThis.fetch = realFetch }
  }
  assert.deepEqual(await removeMinted({}), {})
  assert.deepEqual(cursorFixture.revoked, [7], "only the key Mako minted is revoked: not its namesakes, not the user's own")
  assert.deepEqual(cursorFixture.bearers, ["/auth/exchange_user_api_key key", "/aiserver.v1.DashboardService/ListUserApiKeys session", "/aiserver.v1.DashboardService/RevokeUserApiKey session"], "the key is only ever traded for a session")

  assert.deepEqual(await removeMinted({ keys: listedKeys().map(key => key.id === 7 ? { ...key, maskedKey: "hidden" } : key) }), {})
  assert.deepEqual(cursorFixture.revoked, [7], "a mask shape Mako doesn't know rules nothing out")

  const refused = await removeMinted({ revoke: 500 })
  assert.deepEqual(refused, { stillValid: { reason: "Cursor refused to revoke it (HTTP 500)", expiresAt: new Date(mintedExpiry).toISOString(), manageUrl: "https://cursor.com/dashboard?tab=integrations" } })
  const offline = await removeMinted({ offline: true })
  assert.match(offline.stillValid?.reason ?? "", /^Cursor couldn't be reached/)
  assert.equal(offline.stillValid?.expiresAt, new Date(mintedExpiry).toISOString(), "the person learns when it lapses on its own")
  assert.deepEqual((await removeMinted({ keys: listedKeys().filter(key => key.id !== 7) })).stillValid?.reason, "Cursor's key list doesn't show this key")
  assert.deepEqual(cursorFixture.revoked, [], "a key Mako can't single out is left for the person")
  assert.deepEqual((await removeMinted({ keys: listedKeys([{ id: 11, maskedKey: "crsr_a...xyz", name: "Mako", expiresAt: String(mintedExpiry) }]) })).stillValid?.reason, "Cursor lists more than one key that could be this one")
  assert.deepEqual(cursorFixture.revoked, [])
  assert.deepEqual(await removeMinted({ exchange: 401 }), {}, "a key Cursor already refuses needs no revoking")
  assert.deepEqual(cursorFixture.bearers, ["/auth/exchange_user_api_key key"])
  assert.deepEqual(await removeMinted({}, { method: "pasted", keyName: undefined }), {}, "a pasted key is the person's own: Mako only forgets it")
  assert.deepEqual(cursorFixture.bearers, [], "and asks Cursor nothing")

  // Grok: one auth file per account folder, with who it was kept beside it.
  await writeFile(join(bin, "grok"), `#!${process.execPath}
const fs=require('node:fs'), args=process.argv.slice(2), file=process.env.GROK_AUTH_PATH;
if (args[0]!=='login' || !file || process.env.XAI_API_KEY) process.exit(2);
const email=process.env.FIXTURE_LOGIN_EMAIL||'grok@example.invalid', mode=process.env.FIXTURE_LOGIN_MODE||'browser';
const signIn=() => fs.writeFileSync(file, JSON.stringify({'https://auth.x.ai::fixture': {email, access_token: 'grok-fixture'}}));
process.stdout.write('Opening https://auth.x.example.invalid/authorize?state=fixture\\n');
if (mode==='fail') process.exit(1);
if (mode==='address') { process.stdout.write("Paste the URL here if it doesn't connect: "); process.stdin.once('data', chunk => { if (!String(chunk).startsWith('http://127.0.0.1')) process.exit(1); signIn(); process.exit(0); }); }
else signIn();
`, { mode: 0o700 })
  process.env.XAI_API_KEY = "wrong-api-identity"
  loginEnv("address", "grok@example.invalid")
  const grokLogin = await startAccountLogin("grok")
  assert.equal(grokLogin.paste, "address")
  assert.equal(grokLogin.pasteOnly, undefined, "Grok's page usually hands back by itself")
  assert.throws(() => submitAccountLoginCode(grokLogin.id, "not-an-address"), /address bar/)
  submitAccountLoginCode(grokLogin.id, "http://127.0.0.1:56121/callback?code=fixture")
  const grokAdded = await waitAccountLogin(grokLogin.id)
  assert.equal(grokAdded.status, "added")
  const grokName = grokAdded.status === "added" ? grokAdded.name : ""
  assert.ok(grokAdded.status === "added" && grokAdded.email === "grok@example.invalid")
  const grokEnv = await grok.accountEnv(grokName, process.env)
  assert.equal(grokEnv.GROK_AUTH_PATH, join(accountDir("grok", grokName), "auth.json"))
  assert.equal(grokEnv.XAI_API_KEY, undefined, "an inherited API key cannot outrank the selected account")
  await rm(join(accountDir("grok", grokName), "auth.json"))
  const lapsed = (await grok.listAccounts(null)).find(account => account.name === grokName)
  assert.equal(lapsed?.signedOut, true)
  assert.equal(lapsed?.email, "grok@example.invalid", "who the account was survives Grok deleting its refused login")
  await assert.rejects(grok.accountEnv(grokName, process.env), /signed out/)
  loginEnv(undefined, "grok@example.invalid")
  assert.deepEqual(await waitAccountLogin((await startAccountLogin("grok", grokName)).id), { status: "renewed", name: grokName, email: "grok@example.invalid" })
  delete process.env.XAI_API_KEY

  // Devin: a terminal-only CLI and a pasted code, checked with Devin's own server.
  const devinServer = createServer((request, response) => {
    let body = ""
    request.on("data", chunk => { body += chunk })
    request.on("end", () => {
      const key = valueOf(body)
      response.writeHead(key === "devin-fixture-key" ? 200 : 401, { "Content-Type": "application/json" })
      response.end(key === "devin-fixture-key" ? JSON.stringify({ userStatus: { email: "devin@example.invalid", planStatus: { dailyQuotaRemainingPercent: 80 } } }) : "{}")
    })
  })
  const valueOf = (body: string): string | undefined => z.object({ metadata: z.object({ apiKey: z.string() }) }).safeParse(JSON.parse(body)).data?.metadata.apiKey
  await new Promise<void>(resolve => devinServer.listen(0, "127.0.0.1", resolve))
  const devinUrl = `http://127.0.0.1:${z.object({ port: z.number() }).parse(devinServer.address()).port}`
  try {
    await writeFile(join(bin, "devin"), `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), args=process.argv.slice(2);
if (args.join(' ')!=='auth login --force-manual-token-flow') process.exit(3);
if (!process.stdin.isTTY) { process.stdout.write('Login canceled\\n'); process.exit(1); }
process.stdout.write('\\u001b[sVisit \\u001b]8;;https://app.devin.example.invalid/auth?state=fixture\\u001b\\\\https://app.devin.example.invalid/auth?state=fixture\\u001b]8;;\\u001b\\\\ to sign in, then copy the code and paste it below.\\r\\n\\u001b[6n');
process.stdin.on('data', chunk => {
  const code=String(chunk).replace(/\\u001b\\[[0-9;]*R/g,'').trim();
  if (!code) return;
  if (code!=='fixture-code') { process.stdout.write('Error: Failed to exchange code for host https://app.devin.ai\\r\\n'); return; }
  const dir=path.join(process.env.XDG_DATA_HOME,'devin');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'credentials.toml'),'windsurf_api_key = "devin-fixture-key"\\napi_server_url = ${JSON.stringify(devinUrl)}\\n');
  process.stdout.write('Signed in.\\r\\n');
});
setInterval(() => {}, 1000);
`, { mode: 0o700 })
    process.env.DEVIN_CLI_PATH = join(bin, "devin")
    const refused = await startAccountLogin("devin")
    assert.equal(refused.url, "https://app.devin.example.invalid/auth?state=fixture", "a terminal hyperlink still names its page")
    assert.equal(refused.openPage, true, "Devin prints its page without opening it")
    assert.equal(refused.paste, "code")
    assert.equal(refused.pasteOnly, true)
    submitAccountLoginCode(refused.id, "wrong-code")
    await assert.rejects(waitAccountLogin(refused.id), /didn't accept that code/)
    assert.deepEqual(await managedDirs("devin"), [], "a refused code leaves no profile")
    const devinLogin = await startAccountLogin("devin")
    submitAccountLoginCode(devinLogin.id, "fixture-code")
    const devinAdded = await waitAccountLogin(devinLogin.id)
    assert.equal(devinAdded.status, "added", "a CLI that keeps running after it signs in still finishes")
    const devinName = devinAdded.status === "added" ? devinAdded.name : ""
    assert.ok(devinAdded.status === "added" && devinAdded.email === "devin@example.invalid")
    // A Mako account's key never rides the environment `devin acp` hands its
    // tools: Devin finds it in a data folder that is otherwise the user's.
    const userData = process.env.XDG_DATA_HOME || join(root, ".local", "share")
    const accountData = join(accountDir("devin", devinName), "data")
    await mkdir(join(userData, "devin"), { recursive: true })
    await mkdir(join(userData, "some-tool"), { recursive: true })
    await writeFile(join(userData, "devin", "mcp-auth.json"), "{}")
    await rm(join(accountData, "devin", "cli"), { recursive: true, force: true })
    await mkdir(join(accountData, "devin", "cli", "logs"), { recursive: true })
    await writeFile(join(accountData, "devin", "cli", "logs", "login.log"), "left by the sign-in")
    const devinEnv = await devin.accountEnv(devinName, { ...process.env, WINDSURF_API_KEY: "wrong-api-identity", DEVIN_API_KEY: "wrong-api-identity" })
    for (const key of ["WINDSURF_API_KEY", "WINDSURF_API_SERVER_URL", "DEVIN_API_KEY"]) assert.equal(devinEnv[key], undefined, `${key} must not reach the agent's tools`)
    assert.ok(!Object.values(devinEnv).some(value => value?.includes("devin-fixture-key")), "the key rides no variable at all")
    assert.equal(devinEnv.XDG_DATA_HOME, accountData)
    const seen = (path: string) => realpath(join(accountData, path))
    assert.ok((await lstat(join(accountData, "devin", "credentials.toml"))).isFile(), "Devin reads the account's own login")
    assert.match(await readFile(join(devinEnv.XDG_DATA_HOME, "devin", "credentials.toml"), "utf8"), /devin-fixture-key/)
    assert.equal(await seen("devin/cli"), await realpath(join(userData, "devin", "cli")), "sessions land in the user's Devin folder, where Mako finds them")
    assert.equal(await seen("devin/mcp-auth.json"), await realpath(join(userData, "devin", "mcp-auth.json")))
    assert.equal(await seen("some-tool"), await realpath(join(userData, "some-tool")), "other programs' data stays the user's")
    await mkdir(join(accountData, "made-by-a-tool"))
    await rm(join(userData, "some-tool"), { recursive: true })
    await devin.accountEnv(devinName, process.env)
    await assert.rejects(lstat(join(accountData, "some-tool")), { code: "ENOENT" }, "a link to a removed entry goes with it")
    assert.ok((await lstat(join(accountData, "made-by-a-tool"))).isDirectory(), "what a tool made in the folder is kept")
    assert.ok((await lstat(join(accountData, "devin", "cli"))).isSymbolicLink(), "a later launch keeps the same links")
    await selectAccount("devin", devinName)
    const devinLaunch = await resolveAccountLaunch("devin", { ...process.env, WINDSURF_API_KEY: "wrong-api-identity" })
    assert.equal(devinLaunch.account.name, devinName)
    assert.ok(!Object.entries(devinLaunch.env).some(([key, value]) => key === "WINDSURF_API_KEY" || value?.includes("devin-fixture-key")), "the launch Devin's ACP and headless runs share carries no key")
    assert.equal(devinLaunch.env.XDG_DATA_HOME, accountData)
    await selectAccount("devin", null)
    assert.equal((await devin.accountUsage(devinName)).status, "ok")
    const devinRenewal = await startAccountLogin("devin", devinName)
    submitAccountLoginCode(devinRenewal.id, "fixture-code")
    assert.deepEqual(await waitAccountLogin(devinRenewal.id), { status: "renewed", name: devinName, email: "devin@example.invalid" })
    await assert.rejects(lstat(join(accountDir("devin", devinName), "renewal")), { code: "ENOENT" }, "the renewal folder is gone once its login moved in")
    const devinCancelled = await startAccountLogin("devin", devinName)
    await cancelAccountLogin(devinCancelled.id)
    assert.match(await readFile(join((await devin.accountEnv(devinName, process.env)).XDG_DATA_HOME ?? "", "devin", "credentials.toml"), "utf8"), /devin-fixture-key/, "a cancelled renewal keeps the old login")
    await devin.removeAccount(devinName)
    assert.ok((await lstat(join(userData, "devin", "cli"))).isDirectory(), "removing an account leaves the user's Devin sessions")
    assert.equal(await readFile(join(userData, "devin", "mcp-auth.json"), "utf8"), "{}")
  } finally {
    delete process.env.DEVIN_CLI_PATH
    await new Promise(resolve => devinServer.close(resolve))
  }

  const personalClaude = accountDir("claude", "personal")
  const previousSettings = await claude.credentialRevision("personal", process.env)
  await writeFile(join(personalClaude, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "settings-identity-override" } }))
  assert.notEqual(previousSettings, await claude.credentialRevision("personal", process.env), "settings auth changes invalidate warm admission")
  await assert.rejects(claude.accountEnv("personal", process.env), /home settings override/)
  await writeFile(join(nativeClaude, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://fixture.invalid" } }))
  await assert.rejects(startAccountLogin("claude"), /home settings override/)
  assert.deepEqual(await managedDirs("claude"), [(await managedNames(claude))[0]], "a refused sign-in leaves no profile")
  await assert.rejects(captureAccount("claude", "unsafe-import"), /home settings override/)
  await rm(join(nativeClaude, "settings.json"))

  const legacyHome = join(root, "legacy-config")
  await mkdir(legacyHome)
  assert.equal(await codexModelProvider(legacyHome), "openai", "a missing config uses Codex's default provider")
  for (const contents of ['', 'model_provider = ""', 'model_provider = 42', 'model_provider = true', 'model_provider = ["custom"]', 'model_provider =']) {
    await writeFile(join(legacyHome, "config.toml"), contents)
    assert.equal(await codexModelProvider(legacyHome), "openai", "missing, invalid or empty provider settings use Codex's default")
  }
  await writeFile(join(legacyHome, "config.toml"), 'model_provider = "fixture-provider"\n')
  assert.equal(await codexModelProvider(legacyHome), "fixture-provider", "a configured provider is preserved")
  await rm(join(legacyHome, "config.toml"))
  await writeFile(join(nativeCodex, "config.toml"), 'cli_auth_credentials_store = "file"\n')
  await symlink(join(nativeCodex, "config.toml"), join(legacyHome, "config.toml"))
  await managedCodexConfig(nativeCodex, legacyHome, true)
  assert.equal((await lstat(join(legacyHome, "config.toml"))).isSymbolicLink(), false, "even identical legacy config must detach from the CLI's mutable auth policy")
  await writeFile(join(nativeCodex, "config.toml"), 'model_provider = "fixture-provider"\n')
  await assert.rejects(managedCodexConfig(nativeCodex, legacyHome, true), /another model provider/)
  assert.equal(parse(await readFile(join(legacyHome, "config.toml"), "utf8")).model_provider, undefined, "rejected service changes cannot rewrite the managed profile")

  if (process.platform === "darwin") {
    await writeFile(join(nativeCodex, "config.toml"), 'cli_auth_credentials_store = "keyring"\nmodel = "fixture-model"\n')
    const key = `Codex Auth|cli|${createHash("sha256").update(await realpath(nativeCodex)).digest("hex").slice(0, 16)}`
    stores[key] = codexCredential("keychain-current")
    await saveStore()
    assert.match(await readCodexCredentials(nativeCodex) ?? "", /keychain-current/)
    process.env.MAKO_FIXTURE_KEYCHAIN_DENIED = "1"
    await assert.rejects(readCodexCredentials(nativeCodex), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Could not read macOS Keychain/)
      assert.match(JSON.stringify(error.cause), /security exited 36/)
      assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), /fixture-credential-must-stay-private/)
      return true
    }, "a denied authoritative store cannot fall back to stale file credentials or retain secret native output")
    await assert.rejects(claude.credentialRevision("personal", process.env), /Could not read macOS Keychain/, "permission failure is not a signed-out or plaintext fallback state")
    delete process.env.MAKO_FIXTURE_KEYCHAIN_DENIED
    await captureAccount("codex", "secure")
    const config = parse(await readFile(join(accountDir("codex", "secure"), "config.toml"), "utf8"))
    assert.equal(config.cli_auth_credentials_store, "file")
    assert.equal(config.model, "fixture-model")
    assert.match(await readFile(join(accountDir("codex", "secure"), "auth.json"), "utf8"), /keychain-current/)
    assert.equal(parse(await readFile(join(nativeCodex, "config.toml"), "utf8")).cli_auth_credentials_store, "keyring", "capture does not rewrite native login policy")
    await writeFile(join(nativeCodex, "config.toml"), 'cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = true\n')
    await assert.rejects(readCodexCredentials(nativeCodex), /backend yet/)
  }
  console.log("PASS: in-app sign-in (cancel, failure, code entry, status check, duplicate), signing in again (in place, failed, as someone else), Cursor per-account keys, Grok per-account auth files, Devin's terminal code sign-in, hidden unfinished profiles, the ordinary login as default whatever the shell exported, saved profiles, exact-environment revisions across six adapters, native refresh preservation, and Codex native/managed storage isolation")
} finally {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
