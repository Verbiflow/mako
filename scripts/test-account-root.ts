import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join, resolve } from "node:path"
import { mock } from "node:test"
import { resolveHostEnvironment } from "@mako/host/base/host-environment"
import { createProviderHost, type ProviderHost } from "@mako/host/harnesses/host"
import { claudeAccountCapability } from "@mako/host/harnesses/claude/accounts"
import { codexAccountCapability } from "@mako/host/harnesses/codex/accounts"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"

/*
 * Where accounts live follows the host's user root and nothing else. The
 * installed app and a profile read the `~/.mako/accounts` the person already
 * has, as earlier builds wrote it, so nothing moves; a host isolated in a data
 * root of its own neither reads it nor contends for its lease.
 */

const home = await realpath(await mkdtemp(join(os.tmpdir(), "mako-account-root-")))
mock.method(os, "homedir", () => home)
syncBuiltinESMExports()
const processes = new DiscoveryProcesses()
const hostFor = (env: NodeJS.ProcessEnv): ProviderHost => {
  const environment = resolveHostEnvironment({ env, appRoot: resolve("."), platform: "darwin", home })
  const host = createProviderHost(environment)
  host.accountCapabilities.register(codexAccountCapability(host.accounts.root, processes))
  host.accountCapabilities.register(claudeAccountCapability(host.accounts.root))
  return host
}
try {
  // The layout an installed Mako left: a Codex account it keeps and chose, and Claude's choice in the older shared file.
  const accounts = join(home, ".mako", "accounts")
  const work = join(accounts, "codex", "work")
  await mkdir(work, { recursive: true, mode: 0o700 })
  await writeFile(join(work, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture-account" } }), { mode: 0o600 })
  await mkdir(join(accounts, "selection"), { mode: 0o700 })
  await writeFile(join(accounts, "selection", "codex.json"), JSON.stringify({ codex: "work" }), { mode: 0o600 })
  const personal = join(accounts, "claude", "personal")
  await mkdir(personal, { recursive: true, mode: 0o700 })
  await writeFile(join(accounts, "state.json"), JSON.stringify({ claude: "personal" }), { mode: 0o600 })
  await mkdir(join(home, ".codex"), { recursive: true })

  const installed = hostFor({ MAKO_PROD: "1" })
  const profile = hostFor({ MAKO_PROD: "1", MAKO_PROFILE: "work" })
  const isolated = hostFor({ MAKO_PROD: "1", MAKO_DATA_ROOT: join(home, "proof") })
  assert.equal(installed.accounts.root.path, accounts, "the installed app keeps accounts in ~/.mako/accounts, as before")
  assert.equal(profile.accounts.root.path, accounts, "a profile shares them")
  assert.equal(isolated.accounts.root.path, join(home, "proof", "accounts"), "an isolated host keeps its own in its data root")

  for (const host of [installed, profile]) {
    const launch = await host.accounts.launch("codex", {})
    assert.deepEqual(launch.selection, { kind: "selectable", name: "work" }, "the account the person chose is read where it was written")
    assert.equal(launch.env.CODEX_HOME, work, "and launches from the folder it was signed into")
    assert.equal(await host.accounts.root.readSelection("claude"), "personal", "an older shared selection file is still read")
    assert.deepEqual((await host.accounts.list()).filter((account) => account.active).map((account) => [account.harness, account.name]), [["codex", "work"], ["claude", "personal"]])
  }

  // The isolated host sees none of it: every harness on its own login, and choosing writes only its own root.
  const own = await isolated.accounts.launch("codex", {})
  assert.deepEqual(own.selection, { kind: "selectable", name: null })
  assert.equal(own.env.CODEX_HOME, undefined)
  assert.deepEqual((await isolated.accounts.list()).map((account) => [account.harness, account.name]), [["codex", "default"], ["claude", "default"]])
  await isolated.accounts.select("codex", null)
  assert.deepEqual(JSON.parse(await readFile(join(accounts, "selection", "codex.json"), "utf8")), { codex: "work" }, "the person's choice is untouched")
  assert.deepEqual(JSON.parse(await readFile(join(home, "proof", "accounts", "selection", "codex.json"), "utf8")), { codex: null })

  // The launch lease is per root: while the person's Mako holds it, a profile waits and the isolated host doesn't.
  let releaseLease!: () => void
  const leased = new Promise<void>((resolveLeased) => {
    void installed.accounts.root.withMutation("codex", () => new Promise<void>((release) => {
      releaseLease = release
      resolveLeased()
    }))
  })
  await leased
  let profileLaunched = false
  const waiting = profile.accounts.launch("codex", {}).then(() => { profileLaunched = true })
  await isolated.accounts.launch("codex", {})
  assert.equal(profileLaunched, false, "the isolated host launched while the person's lease was held; the profile still waits for it")
  releaseLease()
  await waiting
  assert.equal(profileLaunched, true)
  console.log("Account root: the installed app and a profile read the existing ~/.mako/accounts unchanged; an isolated host reads, writes and leases only its own")
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(home, { recursive: true, force: true })
}
