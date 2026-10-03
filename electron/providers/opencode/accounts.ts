import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  AccountUsage,
  HarnessAccount,
  OpenCodeAuthType,
} from "../../account-types.js"
import {
  credentialFileFingerprint,
  jsonFields,
  jwtClaims,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { ObservedAccountCapability } from "../account-capability.js"
import { chatGptUsage } from "../chatgpt-usage.js"
import { claudeOAuthUsage } from "../claude/accounts.js"

interface OpenCodeCredential {
  type: OpenCodeAuthType
  access?: string
  accountId?: string
}

function authFile(): string {
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "auth.json"
  )
}

function parseCredential(
  value: JsonValue | undefined
): OpenCodeCredential | null {
  const fields = valueFields(value)
  const type = stringValue(fields?.get("type"))
  if (type !== "oauth" && type !== "api" && type !== "wellknown") return null
  if (type !== "oauth") return { type }
  const access = stringValue(fields?.get("access"))
  const accountId = stringValue(fields?.get("accountId"))
  const credential: OpenCodeCredential = { type }
  if (access !== undefined) credential.access = access
  if (accountId !== undefined) credential.accountId = accountId
  return credential
}

function parseCredentials(contents: string): Map<string, OpenCodeCredential> {
  const credentials = new Map<string, OpenCodeCredential>()
  for (const [providerId, value] of jsonFields(contents)) {
    const credential = parseCredential(value)
    if (credential) credentials.set(providerId, credential)
  }
  return credentials
}

/** Public metadata only: no access, refresh, API key, or expiry escapes. */
export function parseOpenCodeAccounts(
  contents: string,
  path = authFile()
): HarnessAccount[] {
  return [...parseCredentials(contents)].map(([providerId, credential]) => {
    const claims = jwtClaims(credential.access)
    const accountId = claims.accountId ?? credential.accountId
    const account: HarnessAccount = {
      harness: "opencode",
      name: providerId,
      providerId,
      authType: credential.type,
      dir: path,
      active: true,
      source: "opencode",
    }
    if (claims.email !== undefined) account.email = claims.email
    if (accountId !== undefined) account.accountId = accountId
    return account
  })
}

async function accountUsage(providerId: string): Promise<AccountUsage> {
  let credential: OpenCodeCredential | undefined
  try {
    credential = parseCredentials(await readFile(authFile(), "utf8")).get(
      providerId
    )
  } catch {
    return { status: "missing-credentials" }
  }
  if (!credential) return { status: "missing-credentials" }
  if (credential.type !== "oauth")
    return {
      status: "unavailable",
      detail:
        credential.type === "api"
          ? "API keys have no plan limits"
          : "Usage isn't available for this login",
    }
  if (!credential.access) return { status: "missing-credentials" }
  if (providerId === "anthropic")
    return claudeOAuthUsage(credential.access, "OpenCode")
  if (providerId === "openai")
    return chatGptUsage(
      credential.access,
      credential.accountId ?? jwtClaims(credential.access).accountId,
      "OpenCode"
    )
  return {
    status: "unavailable",
    detail: "Plan limits come from ChatGPT and Claude logins only",
  }
}

export const openCodeAccountCapability: ObservedAccountCapability = {
  provider: "opencode",
  mode: "observed",
  label: "OpenCode",
  loginCommand: "opencode auth login",
  listAccounts: async () => {
    const path = authFile()
    return readFile(path, "utf8")
      .then((contents) => parseOpenCodeAccounts(contents, path))
      .catch(() => [])
  },
  // OpenCode owns a multi-provider auth file and does not select isolated homes.
  accountEnv: async (_selection, base) => ({ ...base }),
  selectedAccount: () => ({ name: "default" }),
  credentialRevision: () => credentialFileFingerprint(authFile()),
  accountUsage,
}
