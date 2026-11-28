import assert from "node:assert/strict"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { memorySecrets } from "@mako/host/base/secrets"
import { antigravityAccounts } from "@mako/host/harnesses/antigravity/accounts"
import { claudeAccountCapability, claudeKeyEnvironment } from "@mako/host/harnesses/claude/accounts"
import { withApiKeyAccounts } from "@mako/host/harnesses/api-key-accounts"
import { ExecutionAccountChanged, HarnessAccounts } from "@mako/host/harnesses/accounts"
import { AccountRoot } from "@mako/host/harnesses/accounts-common"
import { ProviderRegistry } from "@mako/host/harnesses/registry"
import type { ProviderAccountCapability } from "@mako/host/harnesses/account-capability"
import { CloudSignInSync, installCloudSignIns } from "@mako/host/harnesses/cloud-sign-ins"
import type { CloudKeptSignIn, CloudSignIn, CloudSignInHarness, CloudSignInsState } from "@mako/host/contracts/cloud-sign-ins"

/**
 * An API-key sign-in, from a key account on the Mac to the harness on a cloud machine, by the one path every key-taking
 * harness shares (`withApiKeyAccounts`): Antigravity's and Claude Code's key accounts are sent as they are, a machine
 * runs the harness's default account on the key it was given, and a sign-in that goes takes the key with it. Fake
 * homes, an in-memory secret store and a stand-in for Mako Cloud; no network, no harness runs.
 */
const root = await mkdtemp(join(os.tmpdir(), "mako-key-sign-ins-"))
const mac = join(root, "mac")
const machine = { home: join(root, "machine", "home"), secrets: join(root, "machine", "secrets") }
let home = mac
mock.method(os, "homedir", () => home)
syncBuiltinESMExports()
const original = { ...process.env }
process.env.HOME = mac
// No Keychain is read: a `security` first on PATH finds nothing and notes that it was asked.
const bin = join(root, "bin")
await mkdir(bin, { recursive: true })
await writeFile(join(bin, "security"), `#!/bin/sh\necho "$1" >> ${JSON.stringify(join(root, "security-runs"))}\nexit 44\n`)
await chmod(join(bin, "security"), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "GEMINI_HOME"]) delete process.env[name]

/** Fixture keys: what must reach the machine's harness, and appear nowhere Settings or the log can see. */
const AGY_KEY = "AIzaSy-test-fixture-antigravity-0001"
const AGY_NEXT = "AIzaSy-test-fixture-antigravity-0002"
const CLAUDE_KEY = "sk-ant-api03-test-fixture-claude-0001"

function harnessesOn(accountRoot: AccountRoot) {
  const secrets = memorySecrets()
  const registry = new ProviderRegistry<ProviderAccountCapability>()
  registry.register(antigravityAccounts(accountRoot, secrets))
  registry.register(withApiKeyAccounts(claudeAccountCapability(accountRoot), accountRoot, secrets, claudeKeyEnvironment))
  return { registry, accounts: new HarnessAccounts(registry, accountRoot) }
}

/** Mako Cloud as the sync sees it: what each device put, and kept chains it can be asked to drop. */
function cloud() {
  const put = new Map<CloudSignInHarness, CloudSignIn>()
  const kept = new Map<CloudSignInHarness, CloudKeptSignIn>()
  const calls: string[] = []
  return {
    put, kept, calls,
    store: {
      blocked: async () => undefined,
      list: async () => ({ signIns: [...put.values()].map((signIn) => ({ harness: signIn.harness, label: signIn.label, expiresAt: signIn.expiresAt, savedAt: "", mine: true })), kept: [...kept.values()] }),
      put: async (signIn: CloudSignIn) => { calls.push(`put ${signIn.harness}`); put.set(signIn.harness, signIn) },
      remove: async (harness: CloudSignInHarness) => { calls.push(`remove ${harness}`); put.delete(harness) },
      share: async () => { throw new Error("a key is never shared as a chain") },
      pull: async () => null,
      refresh: async () => null,
      disconnect: async (harness: CloudSignInHarness) => { calls.push(`disconnect ${harness}`); kept.delete(harness) },
    },
  }
}

const row = (state: CloudSignInsState, harness: string) => state.harnesses.find((entry) => entry.harness === harness)
const said = (state: CloudSignInsState) => JSON.stringify(state)

try {
  // The Mac: each harness's key account, saved as Settings saves a pasted key.
  const macRoot = new AccountRoot(join(mac, ".mako"))
  const { registry, accounts } = harnessesOn(macRoot)
  const fake = cloud()
  // Claude Code was signed in before, and Mako Cloud keeps that sign-in's chain for this Mac.
  fake.kept.set("claude", { harness: "claude", label: "claude@example.invalid", state: "connected", expiresAt: null, connectedAt: new Date().toISOString(), refreshedAt: null, problem: null, token: "AbCdEfGh", source: "shared", mine: true })
  const sync = new CloudSignInSync({ accounts, capabilities: registry, store: fake.store, dataRoot: join(root, "data"), onChange: () => {} })

  // Signed in to Antigravity with Google alone (no key): nothing goes, and Settings says why in one quiet line.
  let state = await sync.check()
  assert.equal(row(state, "antigravity")?.status, "signed-out")
  assert.match(row(state, "antigravity")?.note ?? "", /Gemini API key; a Google sign-in stays on this (Mac|computer)/)
  assert.ok(!fake.put.has("antigravity"))
  console.log("ok  Antigravity without a key sends nothing, and says its Google sign-in stays on this Mac")

  await accounts.addApiKey("antigravity", AGY_KEY)
  await accounts.addApiKey("claude", CLAUDE_KEY)
  state = await sync.check()
  for (const harness of ["antigravity", "claude"] as const) {
    assert.equal(row(state, harness)?.status, "sent", `${harness}'s key account reaches the cloud`)
    assert.equal(row(state, harness)?.label, "API key")
    assert.equal(row(state, harness)?.expiresAt, null, "a key doesn't lapse")
  }
  assert.deepEqual(fake.put.get("antigravity")?.payload, { savedApiKey: AGY_KEY })
  assert.deepEqual(fake.put.get("claude")?.payload, { savedApiKey: CLAUDE_KEY })
  assert.ok(fake.calls.includes("disconnect claude"), "the chain Mako Cloud kept for Claude's earlier sign-in goes, so machines run on the key")
  for (const key of [AGY_KEY, CLAUDE_KEY]) assert.ok(!said(state).includes(key), "Settings sees names and times, never the key")
  const puts = fake.calls.filter((call) => call.startsWith("put")).length
  await sync.check()
  assert.equal(fake.calls.filter((call) => call.startsWith("put")).length, puts, "an unchanged key isn't sent again")
  console.log("ok  a key account's key goes to the cloud as it is, for Antigravity and Claude Code alike, and a kept chain gives way")

  // The machine: its host installs what the account holds, and runs each harness's default account on its key.
  home = machine.home
  process.env.HOME = machine.home
  const machineRoot = new AccountRoot(join(machine.home, ".mako"))
  const onMachine = harnessesOn(machineRoot)
  const signIns = [...fake.put.values()]
  const installed = await installCloudSignIns(onMachine.registry, signIns, machine)
  assert.deepEqual(installed.map((entry) => [entry.harness, entry.status]).sort(), [["antigravity", "installed"], ["claude", "installed"]])
  for (const harness of ["antigravity", "claude"]) {
    const link = join(machine.home, ".mako", "cloud-keys", harness)
    assert.equal(await readlink(link), join(machine.secrets, ".mako", "cloud-keys", harness), `${harness}'s key is linked to the folder in memory`)
    assert.equal((await lstat(join(machine.secrets, ".mako", "cloud-keys", harness))).mode & 0o777, 0o600, `${harness}'s key is the host's alone`)
  }
  const agy = await onMachine.accounts.launch("antigravity", { PATH: process.env.PATH, HOME: machine.home, GOOGLE_API_KEY: "a-stray-key" }, { trackCredential: false })
  assert.equal(agy.env.GEMINI_API_KEY, AGY_KEY, "agy on the machine runs on the key the Mac's key account holds")
  assert.equal(agy.env.GOOGLE_API_KEY, undefined, "no other Google credential rides along")
  assert.ok(agy.env.MAKO_AGY_DATA_DIRECTORY, "its sessions go to a key's own data directory, as on the Mac")
  const claude = await onMachine.accounts.launch("claude", { PATH: process.env.PATH, HOME: machine.home }, { trackCredential: false })
  assert.equal(claude.env.ANTHROPIC_API_KEY, CLAUDE_KEY, "Claude Code on the machine runs on its key")
  console.log("ok  on the machine each harness's default account runs on the key it was given, kept in memory and linked from home")

  // The machine hands its sign-ins over again on every hello and after each fetch, a launch's warm start included: the
  // same key installed again mid-launch is the same credential, and the turn that launch admits goes out.
  const keyFile = (harness: string) => join(machine.secrets, ".mako", "cloud-keys", harness)
  const placed = await Promise.all(["antigravity", "claude"].map(async (harness) => (await lstat(keyFile(harness))).ino))
  const launched = await Promise.all((["antigravity", "claude"] as const).map((harness) => onMachine.accounts.launch(harness, { PATH: process.env.PATH, HOME: machine.home })))
  for (let round = 0; round < 3; round++) {
    await installCloudSignIns(onMachine.registry, signIns, machine)
    await Promise.all(launched.map((launch, index) => onMachine.accounts.assertLaunch(index === 0 ? "antigravity" : "claude", launch)))
  }
  assert.deepEqual(await Promise.all(["antigravity", "claude"].map(async (harness) => (await lstat(keyFile(harness))).ino)), placed, "an unchanged key's file isn't rewritten")
  for (const launch of launched) assert.ok(!launch.credential?.revision.includes(AGY_KEY) && !launch.credential?.revision.includes(CLAUDE_KEY), "a revision is never made of the key")
  console.log("ok  the same key installed again mid-launch leaves the file and the revision as they were, and the launch's turn goes out")

  // A new key on the Mac replaces the machine's, and its launches see the change.
  const capability = onMachine.registry.get("antigravity")!
  const before = await capability.credentialRevision("default")
  assert.ok(!before.includes(AGY_KEY), "a revision is never made of the key")
  home = mac
  process.env.HOME = mac
  const agyAccount = (await accounts.list()).find((account) => account.harness === "antigravity" && account.authType === "api")!
  await accounts.select("antigravity", null)
  await accounts.remove("antigravity", agyAccount.name)
  await accounts.addApiKey("antigravity", AGY_NEXT)
  await sync.check()
  assert.deepEqual(fake.put.get("antigravity")?.payload, { savedApiKey: AGY_NEXT })
  home = machine.home
  process.env.HOME = machine.home
  await installCloudSignIns(onMachine.registry, [...fake.put.values()], machine)
  assert.equal(await readFile(join(machine.home, ".mako", "cloud-keys", "antigravity"), "utf8"), AGY_NEXT)
  assert.notEqual(await capability.credentialRevision("default"), before, "a replaced key is a new credential, so a running agy restarts on it")
  await assert.rejects(onMachine.accounts.assertLaunch("antigravity", launched[0]!), (error) => error instanceof ExecutionAccountChanged && error.reason === "credentials",
    "a launch made on the old key is refused its next turn, and restarts on the new one")
  await onMachine.accounts.assertLaunch("claude", launched[1]!)
  console.log("ok  a key changed on the Mac replaces the machine's, as a new credential")

  // Claude Code signed in again on the Mac and shared as its own sign-in: the key goes, and its own file takes its place.
  const claudeOwn: CloudSignIn = { harness: "claude", label: "claude@example.invalid", expiresAt: null, payload: { credentials: { claudeAiOauth: { accessToken: "access-fixture", refreshToken: "", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } } } }
  await installCloudSignIns(onMachine.registry, [fake.put.get("antigravity")!, claudeOwn], machine)
  assert.equal(await lstat(join(machine.home, ".mako", "cloud-keys", "claude")).catch(() => null), null, "Claude's key went when its own sign-in arrived")
  assert.equal((await onMachine.accounts.launch("claude", { PATH: process.env.PATH, HOME: machine.home }, { trackCredential: false })).env.ANTHROPIC_API_KEY, undefined)

  // The account signed out of Antigravity: its key leaves the machine, and agy runs on nothing it was given.
  const after = await installCloudSignIns(onMachine.registry, [claudeOwn], machine)
  assert.ok(after.some((entry) => entry.harness === "antigravity" && entry.status === "removed"))
  assert.equal(await lstat(join(machine.secrets, ".mako", "cloud-keys", "antigravity")).catch(() => null), null)
  assert.equal((await onMachine.accounts.launch("antigravity", { PATH: process.env.PATH, HOME: machine.home }, { trackCredential: false })).env.GEMINI_API_KEY, undefined)
  console.log("ok  a harness's own sign-in replaces its key on the machine, and a sign-in the account drops takes the key with it")

  // The Mac's own Antigravity sign-in running on GEMINI_API_KEY goes the same way.
  home = mac
  process.env.HOME = mac
  await accounts.select("antigravity", null)
  process.env.GEMINI_API_KEY = AGY_KEY
  state = await sync.check()
  assert.equal(row(state, "antigravity")?.status, "sent")
  assert.deepEqual(fake.put.get("antigravity")?.payload, { savedApiKey: AGY_KEY })
  console.log("ok  Antigravity's own sign-in on GEMINI_API_KEY goes to the cloud as a key account's does")
  sync.stop()
} finally {
  process.env = original
  await rm(root, { recursive: true, force: true })
}
