import assert from "node:assert/strict"
import os from "node:os"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { mock } from "node:test"
import { join } from "node:path"
import {
  completePendingRemovals,
  keepAccount,
  onAccountRemoval,
  removalPending,
  removeAccount,
  resolveAccountLaunch,
  selectAccount,
} from "../electron/accounts.ts"
import { accountHolders } from "../electron/account-holds.ts"
import { readSelection, writeSelection } from "../electron/accounts-common.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { SelectableAccountCapability } from "../electron/providers/account-capability.ts"

const sandbox = await mkdtemp(join(os.tmpdir(), "mako-removal-policy-"))
mock.method(os, "homedir", () => sandbox)
syncBuiltinESMExports()
const events: string[] = []
onAccountRemoval((harness, name, event) => events.push(`${harness}/${name}:${event.status}`))
const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !done(); i++) await delay(10)
  assert.ok(done(), what)
}
try {
  // The shared facade protects every selectable adapter, including a future one.
  for (const provider of [
    ...providerHost.accountCapabilities
      .list()
      .filter((entry) => entry.mode === "selectable")
      .map((entry) => `${entry.provider}-policy-fixture`),
    "future-policy-fixture",
  ]) {
    const names = new Set(["selected", "other", "fails"])
    const deleted: string[] = []
    const capability: SelectableAccountCapability = {
      provider,
      label: provider,
      mode: "selectable",
      loginCommand: "fixture login",
      listAccounts: async () => [],
      captureAccount: async () => {},
      credentialRevision: async () => "fixture-credentials",
      accountEnv: async (name, base) => {
        if (name && !names.has(name))
          throw new Error("Missing selected account")
        return { ...base, FIXTURE_ACCOUNT: name ?? "default" }
      },
      selectedAccount: (name) => ({ name: name ?? "default" }),
      accountUsage: async () => ({ status: "unavailable" }),
      removeAccount: async (name) => {
        if (name === "fails") throw new Error("Native removal failed")
        names.delete(name)
        deleted.push(name)
        return name === "other" ? { stillValid: { reason: "the provider couldn't be reached", manageUrl: "https://provider.example.invalid/keys" } } : {}
      },
    }
    const dispose = providerHost.accountCapabilities.register(capability)
    try {
      await selectAccount(provider, "selected")
      const launched = await resolveAccountLaunch(provider, { FIXTURE_ACCOUNT: "inherited" })
      assert.equal(launched.account.name, "selected")
      assert.equal(launched.env.FIXTURE_ACCOUNT, "selected")
      assert.equal(launched.hold, undefined, "a launch nobody holds keeps nothing")
      await assert.rejects(
        removeAccount(provider, "selected"),
        /Choose another account/
      )
      assert.equal(await readSelection(provider), "selected")
      assert.equal(deleted.length, 0)
      await assert.rejects(
        removeAccount(provider, "fails"),
        /Native removal failed/
      )
      assert.equal(removalPending(provider, "fails"), false, "a failed removal leaves no marker behind")
      assert.equal(await readSelection(provider), "selected")
      await Promise.all([
        selectAccount(provider, "other"),
        removeAccount(provider, "selected"),
      ])
      assert.equal(await readSelection(provider), "other")
      assert.equal(launched.account.name, "selected", "later selection never relabels a resolved launch")
      const nextLaunch = await resolveAccountLaunch(provider, {})
      assert.equal(nextLaunch.account.name, "other")
      assert.equal(nextLaunch.env.FIXTURE_ACCOUNT, "other")
      assert.deepEqual(deleted, ["selected"])
      // An explicit default selection is an identity change the user requested.
      await selectAccount(provider, null)
      assert.deepEqual(await removeAccount(provider, "other"), { status: "removed", stillValid: { reason: "the provider couldn't be reached", manageUrl: "https://provider.example.invalid/keys" } }, "a key the provider still accepts reaches the window")
      assert.equal(await readSelection(provider), null)

      // Running work keeps its account: removal waits, refuses selection
      // meanwhile, and finishes when the last holder lets go.
      names.add("held")
      await selectAccount(provider, "held")
      const session = await resolveAccountLaunch(provider, {}, { holder: { kind: "session", binding: `${provider}-binding` } })
      const run = await resolveAccountLaunch(provider, {}, { holder: { kind: "run" } })
      assert.deepEqual(accountHolders(provider, "held"), [{ kind: "session", binding: `${provider}-binding` }, { kind: "run" }])
      await selectAccount(provider, null)
      assert.equal((await resolveAccountLaunch(provider, {}, { holder: { kind: "utility" } })).hold, undefined, "the CLI's own login is never held")
      assert.deepEqual(await removeAccount(provider, "held"), { status: "pending" })
      assert.equal(removalPending(provider, "held"), true)
      assert.equal(events.at(-1), `${provider}/held:pending`)
      await assert.rejects(selectAccount(provider, "held"), /being removed/, "a removing account can't become the one new work uses")
      session.hold!.release()
      session.hold!.release()
      await delay(30)
      assert.equal(deleted.includes("held"), false, "credentials stay while any holder runs")
      run.hold!.release()
      await until(() => deleted.includes("held"), "the last holder letting go finishes the removal")
      await until(() => events.at(-1) === `${provider}/held:removed`, "the window hears the removal finished")
      assert.equal(removalPending(provider, "held"), false)

      // Keep withdraws a pending removal; the account works again.
      names.add("kept")
      await selectAccount(provider, "kept")
      const utility = await resolveAccountLaunch(provider, {}, { holder: { kind: "utility" } })
      await selectAccount(provider, null)
      assert.deepEqual(await removeAccount(provider, "kept"), { status: "pending" })
      assert.equal(await keepAccount(provider, "kept"), true)
      assert.equal(events.at(-1), `${provider}/kept:kept`)
      utility.hold!.release()
      await delay(30)
      assert.equal(deleted.includes("kept"), false, "a kept account survives its holder letting go")
      await selectAccount(provider, "kept")
      await selectAccount(provider, null)
      assert.equal(await keepAccount(provider, "kept"), false, "nothing to keep once no removal waits")

      // A removal that fails late says so and leaves the account as it was.
      await selectAccount(provider, "fails")
      const failing = await resolveAccountLaunch(provider, {}, { holder: { kind: "run" } })
      await selectAccount(provider, null)
      assert.deepEqual(await removeAccount(provider, "fails"), { status: "pending" })
      failing.hold!.release()
      await until(() => events.at(-1) === `${provider}/fails:failed`, "a late failure reaches the window")
      assert.equal(removalPending(provider, "fails"), false)
      await selectAccount(provider, "fails")
      await selectAccount(provider, null)

      // Another Mako selecting it while its removal waits keeps it.
      names.add("chosen")
      await selectAccount(provider, "chosen")
      const chosen = await resolveAccountLaunch(provider, {}, { holder: { kind: "run" } })
      await selectAccount(provider, null)
      assert.deepEqual(await removeAccount(provider, "chosen"), { status: "pending" })
      await writeSelection(provider, "chosen")
      chosen.hold!.release()
      await until(() => events.at(-1) === `${provider}/chosen:kept`, "the window hears a selection kept it")
      assert.equal(deleted.includes("chosen"), false, "a selected account is never deleted")
      assert.equal(removalPending(provider, "chosen"), false)
      await selectAccount(provider, null)

      // A removal a quit left waiting finishes at the next start.
      names.add("orphan")
      await mkdir(join(sandbox, ".mako", "accounts", "removing", provider), { recursive: true })
      await writeFile(join(sandbox, ".mako", "accounts", "removing", provider, "orphan.json"), "{}")
      await completePendingRemovals()
      assert.equal(deleted.includes("orphan"), true)
      assert.equal(removalPending(provider, "orphan"), false)

      // A lease left by an exited host, or a pid now running something else, holds nothing.
      names.add("leased")
      const holds = join(sandbox, ".mako", "accounts", "holds")
      await mkdir(holds, { recursive: true })
      await writeFile(join(holds, "999999.json"), JSON.stringify({ version: 1, pid: 999_999, startedAt: Date.now(), accounts: [`${provider}/leased`] }))
      await writeFile(join(holds, `${process.ppid}.json`), JSON.stringify({ version: 1, pid: process.ppid, startedAt: 1_000, accounts: [`${provider}/leased`] }))
      assert.deepEqual(await removeAccount(provider, "leased"), { status: "removed" })
      assert.equal(existsSync(join(holds, "999999.json")), false, "the exited host's lease is cleared")
      assert.equal(existsSync(join(holds, `${process.ppid}.json`)), false, "a recycled pid's lease is cleared")
    } finally {
      dispose()
    }
  }
  await writeFile(join(sandbox, "victim"), "isolated fixture credentials")
  await writeSelection("cross-profile-fixture", "other")
  const messages = new Map<string, string[]>()
  const worker = (action: string) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/account-mutation-worker.ts", import.meta.url)
        ),
        sandbox,
        action,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }
    )
    messages.set(action, [])
    child.on("message", (message) =>
      messages.get(action)!.push(String(message))
    )
    return child
  }
  const wait = async (action: string, message: string) => {
    for (let i = 0; i < 1000 && !messages.get(action)?.includes(message); i++)
      await delay(10)
    assert.ok(
      messages.get(action)?.includes(message),
      `${action} did not report ${message}`
    )
  }
  const removing = worker("remove")
  let selecting: ReturnType<typeof worker> | undefined
  try {
    await wait("remove", "deleting")
    selecting = worker("select")
    await wait("select", "selecting")
    await delay(200)
    assert.equal(
      messages.get("select")?.includes("validated"),
      false,
      "other profile waits for credential deletion before validating selection"
    )
    removing.send("finish")
    await wait("remove", "success")
    await wait("select", "rejected")
    assert.equal(
      await readSelection("cross-profile-fixture"),
      "other",
      "deleted credentials cannot become selected in another profile"
    )
  } finally {
    removing.kill()
    selecting?.kill()
  }

  // Another Mako sharing ~/.mako runs a session on the account: removal
  // here waits for it, and that host finishes it when its session lets go.
  await writeFile(join(sandbox, "shared"), "isolated fixture credentials")
  await writeSelection("cross-profile-fixture", "shared")
  const holding = worker("hold")
  const dispose = providerHost.accountCapabilities.register({
    provider: "cross-profile-fixture",
    label: "fixture",
    mode: "selectable",
    loginCommand: "fixture",
    listAccounts: async () => [],
    captureAccount: async () => {},
    credentialRevision: async () => "fixture-credentials",
    accountEnv: async (_name, base) => base,
    selectedAccount: (name) => ({ name: name ?? "default" }),
    accountUsage: async () => ({ status: "unavailable" }),
    removeAccount: async (name) => {
      await rm(join(sandbox, name))
      return {}
    },
  })
  try {
    await wait("hold", "holding")
    await writeSelection("cross-profile-fixture", "other")
    assert.deepEqual(await removeAccount("cross-profile-fixture", "shared"), { status: "pending" }, "another host's live session holds the account")
    assert.equal(existsSync(join(sandbox, "shared")), true)
    holding.send("finish")
    await wait("hold", "removed")
    assert.equal(existsSync(join(sandbox, "shared")), false, "the host that let go last finished the removal")
    assert.equal(removalPending("cross-profile-fixture", "shared"), false)
  } finally {
    dispose()
    holding.kill()
  }
  console.log(
    "PASS: removal never deletes credentials running work holds — it waits, refuses selection, finishes on the last release here or in another Mako, can be kept, reports late failures and finishes after a restart — across selectable harnesses and a future adapter; selected deletion is refused and concurrent mutations serialize across app profiles"
  )
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(sandbox, { recursive: true, force: true })
}
