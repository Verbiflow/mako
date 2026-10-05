import os from "node:os"
import { syncBuiltinESMExports } from "node:module"
import { mock } from "node:test"
import { access, rm } from "node:fs/promises"
import { join } from "node:path"
import { removeAccount, selectAccount } from "../../electron/accounts.ts"
import { providerHost } from "../../electron/providers/index.ts"
const root = process.argv[2]!,
  action = process.argv[3]!
mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
const release = Promise.withResolvers<void>()
process.on("message", () => release.resolve())
providerHost.accountCapabilities.register({
  provider: "cross-profile-fixture",
  label: "fixture",
  mode: "selectable",
  loginCommand: "fixture",
  listAccounts: async () => [],
  captureAccount: async () => {},
  credentialRevision: async () => "fixture-credentials",
      accountEnv: async (name, base) => {
    if (name) await access(join(root, name))
    process.send?.("validated")
    return base
  },
  selectedAccount: (name) => ({ name: name ?? "default" }),
  accountUsage: async () => ({ status: "unavailable" }),
  removeAccount: async (name) => {
    process.send?.("deleting")
    await release.promise
    await rm(join(root, name))
    return {}
  },
})
try {
  if (action === "remove")
    await removeAccount("cross-profile-fixture", "victim")
  else {
    process.send?.("selecting")
    await selectAccount("cross-profile-fixture", "victim")
  }
  process.send?.("success")
} catch {
  process.send?.("rejected")
}
process.disconnect?.()
