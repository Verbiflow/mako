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
import { AccountRoot } from "@mako/host/harnesses/accounts-common"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import type { SelectableAccountCapability } from "@mako/host/harnesses/account-capability"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const sandbox = await mkdtemp(join(os.tmpdir(), "mako-removal-policy-"))
// Every host here shares the sandbox's `~/.mako`, as the installed app and its profiles share the person's.
const providerHost = createHarnessHost(detachedHarnessContext(nativeStores, join(sandbox, "data"), join(sandbox, ".mako")))
const shared = new AccountRoot(join(sandbox, ".mako"))
mock.method(os, "homedir", () => sandbox)
syncBuiltinESMExports()
const { accounts } = providerHost
const events: string[] = []
accounts.onRemoval((harness, name, event) => events.push(`${harness}/${name}:${event.status}`))
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
      await accounts.select(provider, "selected")
      const launched = await accounts.launch(provider, { FIXTURE_ACCOUNT: "inherited" })
      assert.equal(launched.account.name, "selected")
      assert.equal(launched.env.FIXTURE_ACCOUNT, "selected")
      assert.equal(launched.hold, undefined, "a launch nobody holds keeps nothing")
      await assert.rejects(
        accounts.remove(provider, "selected"),
        /Choose another account/
      )
      assert.equal(await shared.readSelection(provider), "selected")
      assert.equal(deleted.length, 0)
      await assert.rejects(
        accounts.remove(provider, "fails"),
        /Native removal failed/
      )
      assert.equal(accounts.removalPending(provider, "fails"), false, "a failed removal leaves no marker behind")
      assert.equal(await shared.readSelection(provider), "selected")
      await Promise.all([
        accounts.select(provider, "other"),
        accounts.remove(provider, "selected"),
      ])
      assert.equal(await shared.readSelection(provider), "other")
      assert.equal(launched.account.name, "selected", "later selection never relabels a resolved launch")
      const nextLaunch = await accounts.launch(provider, {})
      assert.equal(nextLaunch.account.name, "other")
      assert.equal(nextLaunch.env.FIXTURE_ACCOUNT, "other")
      assert.deepEqual(deleted, ["selected"])
      // An explicit default selection is an identity change the user requested.
      await accounts.select(provider, null)
      assert.deepEqual(await accounts.remove(provider, "other"), { status: "removed", stillValid: { reason: "the provider couldn't be reached", manageUrl: "https://provider.example.invalid/keys" } }, "a key the provider still accepts reaches the window")
      assert.equal(await shared.readSelection(provider), null)

      // Running work keeps its account: removal waits, refuses selection
      // meanwhile, and finishes when the last holder lets go.
      names.add("held")
      await accounts.select(provider, "held")
      const session = await accounts.launch(provider, {}, { holder: { kind: "session", binding: `${provider}-binding` } })
      const run = await accounts.launch(provider, {}, { holder: { kind: "run" } })
      assert.deepEqual(accounts.holds.holders(provider, "held"), [{ kind: "session", binding: `${provider}-binding` }, { kind: "run" }])
      await accounts.select(provider, null)
      assert.equal((await accounts.launch(provider, {}, { holder: { kind: "utility" } })).hold, undefined, "the CLI's own login is never held")
      assert.deepEqual(await accounts.remove(provider, "held"), { status: "pending" })
      assert.equal(accounts.removalPending(provider, "held"), true)
      assert.equal(events.at(-1), `${provider}/held:pending`)
      await assert.rejects(accounts.select(provider, "held"), /being removed/, "a removing account can't become the one new work uses")
      session.hold!.release()
      session.hold!.release()
      await delay(30)
      assert.equal(deleted.includes("held"), false, "credentials stay while any holder runs")
      run.hold!.release()
      await until(() => deleted.includes("held"), "the last holder letting go finishes the removal")
      await until(() => events.at(-1) === `${provider}/held:removed`, "the window hears the removal finished")
      assert.equal(accounts.removalPending(provider, "held"), false)

      // Keep withdraws a pending removal; the account works again.
      names.add("kept")
      await accounts.select(provider, "kept")
      const utility = await accounts.launch(provider, {}, { holder: { kind: "utility" } })
      await accounts.select(provider, null)
      assert.deepEqual(await accounts.remove(provider, "kept"), { status: "pending" })
      assert.equal(await accounts.keep(provider, "kept"), true)
      assert.equal(events.at(-1), `${provider}/kept:kept`)
      utility.hold!.release()
      await delay(30)
      assert.equal(deleted.includes("kept"), false, "a kept account survives its holder letting go")
      await accounts.select(provider, "kept")
      await accounts.select(provider, null)
      assert.equal(await accounts.keep(provider, "kept"), false, "nothing to keep once no removal waits")

      // A removal that fails late says so and leaves the account as it was.
      await accounts.select(provider, "fails")
      const failing = await accounts.launch(provider, {}, { holder: { kind: "run" } })
      await accounts.select(provider, null)
      assert.deepEqual(await accounts.remove(provider, "fails"), { status: "pending" })
      failing.hold!.release()
      await until(() => events.at(-1) === `${provider}/fails:failed`, "a late failure reaches the window")
      assert.equal(accounts.removalPending(provider, "fails"), false)
      await accounts.select(provider, "fails")
      await accounts.select(provider, null)

      // Another Mako selecting it while its removal waits keeps it.
      names.add("chosen")
      await accounts.select(provider, "chosen")
      const chosen = await accounts.launch(provider, {}, { holder: { kind: "run" } })
      await accounts.select(provider, null)
      assert.deepEqual(await accounts.remove(provider, "chosen"), { status: "pending" })
      await shared.writeSelection(provider, "chosen")
      chosen.hold!.release()
      await until(() => events.at(-1) === `${provider}/chosen:kept`, "the window hears a selection kept it")
      assert.equal(deleted.includes("chosen"), false, "a selected account is never deleted")
      assert.equal(accounts.removalPending(provider, "chosen"), false)
      await accounts.select(provider, null)

      // A removal a quit left waiting finishes at the next start.
      names.add("orphan")
      await mkdir(join(sandbox, ".mako", "accounts", "removing", provider), { recursive: true })
      await writeFile(join(sandbox, ".mako", "accounts", "removing", provider, "orphan.json"), "{}")
      await accounts.completePendingRemovals()
      assert.equal(deleted.includes("orphan"), true)
      assert.equal(accounts.removalPending(provider, "orphan"), false)

      // A lease left by an exited host, or a pid now running something else, holds nothing.
      names.add("leased")
      const holds = join(sandbox, ".mako", "accounts", "holds")
      await mkdir(holds, { recursive: true })
      await writeFile(join(holds, "999999.json"), JSON.stringify({ version: 1, pid: 999_999, startedAt: Date.now(), accounts: [`${provider}/leased`] }))
      await writeFile(join(holds, `${process.ppid}.json`), JSON.stringify({ version: 1, pid: process.ppid, startedAt: 1_000, accounts: [`${provider}/leased`] }))
      assert.deepEqual(await accounts.remove(provider, "leased"), { status: "removed" })
      assert.equal(existsSync(join(holds, "999999.json")), false, "the exited host's lease is cleared")
      assert.equal(existsSync(join(holds, `${process.ppid}.json`)), false, "a recycled pid's lease is cleared")
    } finally {
      dispose()
    }
  }
  await writeFile(join(sandbox, "victim"), "isolated fixture credentials")
  await shared.writeSelection("cross-profile-fixture", "other")
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
      await shared.readSelection("cross-profile-fixture"),
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
  await shared.writeSelection("cross-profile-fixture", "shared")
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
    await shared.writeSelection("cross-profile-fixture", "other")
    assert.deepEqual(await accounts.remove("cross-profile-fixture", "shared"), { status: "pending" }, "another host's live session holds the account")
    assert.equal(existsSync(join(sandbox, "shared")), true)
    holding.send("finish")
    await wait("hold", "removed")
    assert.equal(existsSync(join(sandbox, "shared")), false, "the host that let go last finished the removal")
    assert.equal(accounts.removalPending("cross-profile-fixture", "shared"), false)
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
