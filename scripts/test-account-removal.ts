import assert from "node:assert/strict"
import os from "node:os"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { mock } from "node:test"
import { join } from "node:path"
import { removeAccount, resolveAccountLaunch, selectAccount } from "../electron/accounts.ts"
import { readSelection, writeSelection } from "../electron/accounts-common.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { SelectableAccountCapability } from "../electron/providers/account-capability.ts"

const sandbox = await mkdtemp(join(os.tmpdir(), "mako-removal-policy-"))
mock.method(os, "homedir", () => sandbox)
syncBuiltinESMExports()
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
      await assert.rejects(
        removeAccount(provider, "selected"),
        /Choose another account/
      )
      assert.equal(await readSelection(provider), "selected")
      assert.deepEqual(deleted, [])
      await assert.rejects(
        removeAccount(provider, "fails"),
        /Native removal failed/
      )
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
      assert.deepEqual(await removeAccount(provider, "other"), { stillValid: { reason: "the provider couldn't be reached", manageUrl: "https://provider.example.invalid/keys" } }, "a key the provider still accepts reaches the window")
      assert.equal(await readSelection(provider), null)
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
  console.log(
    "PASS: selected deletion is refused, failed deletion preserves identity, and concurrent mutations serialize across selectable harnesses, a future adapter and separate app profiles"
  )
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(sandbox, { recursive: true, force: true })
}
