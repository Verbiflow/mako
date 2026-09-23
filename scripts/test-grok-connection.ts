import assert from "node:assert/strict"
import { describeConnection } from "../electron/providers/connection-capability.ts"
import {
  grokConnection,
  grokConnectionState,
} from "../electron/providers/grok/connection.ts"
import { grokUpdateEnvironment } from "../electron/providers/grok/index.ts"
import { resolveExecutable } from "../electron/executable.ts"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProviderConnectionState } from "../electron/contracts/provider-connection.ts"

assert.deepEqual(
  grokConnectionState({
    protocolVersion: 1,
    authMethods: [{ id: "grok.com", name: "Grok" }],
  }),
  { status: "signed-out" }
)
assert.deepEqual(
  grokConnectionState({
    protocolVersion: 1,
    authMethods: [{ id: "cached_token", name: "Cached" }],
  }),
  { status: "signed-in", source: "cli" }
)
assert.deepEqual(
  grokConnectionState({
    protocolVersion: 1,
    authMethods: [{ id: "xai.api_key", name: "Key" }],
  }),
  { status: "signed-in", source: "env" }
)
assert.equal(
  grokConnectionState({
    protocolVersion: 1,
    _meta: { defaultAuthMethodId: "oidc" },
    authMethods: [{ id: "cached_token", name: "Cached" }],
  }).status,
  "signed-out",
  "respect the provider's chosen auth method"
)
let state: ProviderConnectionState = { status: "signed-out" }
const commands: string[][] = []
let verified = 0
let changed = 0
const capability = grokConnection({
  read: async () => state,
  run: async (args) => {
    commands.push(args)
    state =
      args[0] === "login"
        ? { status: "signed-in", source: "cli" }
        : { status: "signed-out" }
  },
  verifyModels: async () => {
    verified++
  },
})
capability.onChange?.(() => {
  changed++
})
assert.equal((await capability.status()).status, "signed-out")
assert.equal(
  (await capability.act({ kind: "sign-in-browser" })).status,
  "signed-in"
)
assert.equal(verified, 1)
assert.equal(changed, 1)
assert.deepEqual(commands, [["login", "--oauth"]])
await capability.act({ kind: "sign-out" })
assert.equal((await capability.status()).status, "signed-out")
assert.equal(changed, 2)
assert.deepEqual(commands[1], ["logout"])
await assert.rejects(
  capability.act({ kind: "sign-in-key", apiKey: "fixture" }),
  /CLI configuration/
)
const rejected = grokConnection({
  read: async () => ({ status: "signed-out" }),
  run: async () => {},
})
await assert.rejects(
  rejected.act({ kind: "sign-in-browser" }),
  /could not be verified/
)
const unavailable = grokConnection({
  read: async () => {
    throw new Error("Offline")
  },
})
assert.equal(
  (await unavailable.status()).status,
  "unavailable",
  "a failed probe must not claim the user signed out"
)
if (process.argv.includes("--live")) {
  const env = { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }
  const repaired = grokUpdateEnvironment(env)
  assert.equal(repaired.npm_config_allow_scripts, "@xai-official/grok")
  const npm = resolveExecutable("npm", repaired)
  assert.ok(npm)
  const grok = resolveExecutable("grok", repaired)
  assert.ok(grok)
  const result = await promisify(execFile)(
    grok,
    ["update", "--check", "--json"],
    { env: repaired, timeout: 20_000 }
  )
  const { z } = await import("zod")
  const checked = z
    .object({
      error: z.string().nullable(),
      latestVersion: z.string().nullable(),
    })
    .parse(JSON.parse(result.stdout))
  assert.equal(checked.error, null)
  assert.ok(checked.latestVersion)
  const live = grokConnection({ env: () => repaired })
  assert.notEqual((await live.status(true)).status, "unavailable")
}
console.log(
  "Grok connection: provider-owned browser login, fresh verification, logout, explicit failure and desktop updater environment hold"
)

const failedStatus = await describeConnection({
  ...capability,
  status: async () => {
    throw new Error("probe failed")
  },
  secureStorage: async () => {
    throw new Error("locked")
  },
})
assert.equal(failedStatus.state.status, "unavailable")
assert.equal(failedStatus.secureStorage, false)
