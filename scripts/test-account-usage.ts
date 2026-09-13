import assert from "node:assert/strict"
import {
  accountEnv,
  selectedAccount,
  type UsageWindow,
} from "../electron/accounts"
import { classifyCodexWindows } from "../electron/providers/codex/accounts"
import { parseOpenCodeAccounts } from "../electron/providers/opencode/accounts"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"

const fiveHour: UsageWindow = {
  usedPercent: 40,
  windowMinutes: 300,
  resetsAt: 1,
}
const week: UsageWindow = {
  usedPercent: 15,
  windowMinutes: 10_080,
  resetsAt: 2,
}

assert.deepEqual(classifyCodexWindows([week]), {
  session: null,
  weekly: week,
})
assert.deepEqual(classifyCodexWindows([week, fiveHour]), {
  session: fiveHour,
  weekly: week,
})

const jwtHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString(
  "base64url"
)
const jwtPayload = Buffer.from(
  JSON.stringify({
    "https://api.openai.com/profile": { email: "fixture@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
  })
).toString("base64url")
const accessToken = `${jwtHeader}.${jwtPayload}.fixture-signature`
const secrets = {
  accessToken,
  refreshToken: "refresh-secret-fixture",
  apiKey: "api-secret-fixture",
}
const discovered = parseOpenCodeAccounts(
  JSON.stringify({
    openai: {
      type: "oauth",
      access: secrets.accessToken,
      refresh: secrets.refreshToken,
      expires: 9_999_999_999_999,
      accountId: "stored-account-fallback",
    },
    anthropic: { type: "api", key: secrets.apiKey },
  }),
  "/fixture/opencode/auth.json"
)

assert.deepEqual(discovered, [
  {
    harness: "opencode",
    name: "openai",
    providerId: "openai",
    authType: "oauth",
    email: "fixture@example.com",
    accountId: "account-fixture",
    dir: "/fixture/opencode/auth.json",
    active: true,
    source: "opencode",
  },
  {
    harness: "opencode",
    name: "anthropic",
    providerId: "anthropic",
    authType: "api",
    dir: "/fixture/opencode/auth.json",
    active: true,
    source: "opencode",
  },
])
const serialized = JSON.stringify(discovered)
for (const secret of Object.values(secrets)) {
  assert.equal(serialized.includes(secret), false)
}
for (const secretField of ["access", "refresh", "key", "token", "expires"]) {
  assert.equal(serialized.includes(`"${secretField}"`), false)
}
assert.equal(serialized.includes("stored-account-fallback"), false)

const openCodeCatalog = normalizeOpenCodeModels([
  { providerID: "openai", id: "gpt-5.4", name: "GPT-5.4" },
  {
    providerID: "opencode",
    id: "x-preview-f-free",
    name: "Ox Alpha Free (Unlimited)",
  },
])
assert.equal(openCodeCatalog.defaultModel, undefined)
assert.deepEqual(openCodeCatalog.models.map((model) => model.id), [
  "openai/gpt-5.4",
  "opencode/x-preview-f-free",
])

const childEnv = await accountEnv("opencode", {
  PATH: "/fixture/bin",
  MAKO_BACKEND_TOKEN: "backend-secret",
  MAKO_CUA_SOCKET: "/fixture/cua.sock",
  MAKO_DATA_ROOT: "/fixture/Application Support/mako",
  MAKO_WEB_SOCKET: "/fixture/mako-host/host.sock",
  MAKO_HOST_ONLY: "1",
  MAKO_WEB_ONLY: "1",
  MAKO_PROFILE: "dev",
})
assert.equal(childEnv.PATH, "/fixture/bin")
assert.equal(childEnv.MAKO_BACKEND_TOKEN, undefined)
assert.equal(childEnv.MAKO_CUA_SOCKET, undefined)
// The host's own launch variables stay with the host: an agent that runs
// `npm run dev` from a provider process must start or attach to the dev
// profile, not the host that spawned it.
for (const key of ["MAKO_DATA_ROOT", "MAKO_WEB_SOCKET", "MAKO_HOST_ONLY", "MAKO_WEB_ONLY", "MAKO_PROFILE"])
  assert.equal(childEnv[key], undefined, `${key} leaked into a provider process`)

// Providers without an account capability retain the default account and
// inherit ordinary process values while Mako runtime secrets stay isolated.
const cursorEnv = await accountEnv("cursor", {
  PATH: "/fixture/bin",
  CURSOR_API_KEY: "provider-owned-fixture",
  MAKO_BACKEND_TOKEN: "backend-secret",
})
assert.deepEqual(cursorEnv, {
  PATH: "/fixture/bin",
  CURSOR_API_KEY: "provider-owned-fixture",
})
assert.deepEqual(await selectedAccount("cursor"), { name: "default" })

console.log(
  "Account discovery, usage classification, and child environment isolation passed"
)
