import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { openCodeDatabasePaths } from "@mako/sessions"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import type {
  AccountUsage,
  HarnessAccount,
  OpenCodeAuthType,
} from "../../account-types.js"
import {
  credentialFileFingerprint,
  credentialFingerprint,
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

/** OpenCode 1's credential file; OpenCode 2 reads it only until it has moved the logins into its database. */
function authFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "auth.json"
  )
}

function parseCredential(
  value: JsonValue | undefined
): OpenCodeCredential | null {
  const fields = valueFields(value)
  const raw = stringValue(fields?.get("type"))
  // OpenCode 2 names an API key `key`; OpenCode 1 named it `api`.
  const type = raw === "key" ? "api" : raw
  if (type !== "oauth" && type !== "api" && type !== "wellknown") return null
  if (type !== "oauth") return { type }
  const access = stringValue(fields?.get("access"))
  const accountId =
    stringValue(fields?.get("accountId")) ??
    stringValue(valueFields(fields?.get("metadata"))?.get("accountID"))
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

const CredentialRow = z.object({ provider: z.string(), value: z.string() })

/** OpenCode 2's active login per provider: one row each in the database that also holds its sessions. */
function databaseCredentials(env: NodeJS.ProcessEnv): { path: string; credentials: Map<string, OpenCodeCredential> } | null {
  for (const path of openCodeDatabasePaths(env)) {
    if (!existsSync(path)) continue
    let db: ReturnType<typeof openNativeStore> | undefined
    try {
      db = openNativeStore(path, { timeout: 1_000 })
      const rows = db
        .prepare("SELECT integration_id AS provider, value FROM credential WHERE active = 1 AND integration_id IS NOT NULL")
        .all()
      const credentials = new Map<string, OpenCodeCredential>()
      for (const row of rows) {
        const parsed = CredentialRow.safeParse(row)
        if (!parsed.success) continue
        try {
          const credential = parseCredential(JSON.parse(parsed.data.value))
          if (credential) credentials.set(parsed.data.provider, credential)
        } catch {
          // A row OpenCode wrote in a shape Mako doesn't read is left out.
        }
      }
      if (credentials.size > 0) return { path, credentials }
    } catch {
      // An older database has no credential table.
    } finally {
      db?.close()
    }
  }
  return null
}

async function openCodeCredentials(env: NodeJS.ProcessEnv = process.env): Promise<{ path: string; credentials: Map<string, OpenCodeCredential> } | null> {
  const stored = databaseCredentials(env)
  if (stored) return stored
  const path = authFile(env)
  try {
    return { path, credentials: parseCredentials(await readFile(path, "utf8")) }
  } catch {
    return null
  }
}

function accountsFrom(credentials: Map<string, OpenCodeCredential>, path: string): HarnessAccount[] {
  return [...credentials].map(([providerId, credential]) => {
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

/** Public metadata only: no access, refresh, API key, or expiry escapes. */
export function parseOpenCodeAccounts(
  contents: string,
  path = authFile()
): HarnessAccount[] {
  return accountsFrom(parseCredentials(contents), path)
}

async function accountUsage(providerId: string): Promise<AccountUsage> {
  const credential = (await openCodeCredentials())?.credentials.get(providerId)
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
  readOnlyReason:
    "OpenCode keeps its logins inside the database that holds its sessions, so a second OpenCode login would split your OpenCode history.",
  listAccounts: async () => {
    const stored = await openCodeCredentials()
    return stored ? accountsFrom(stored.credentials, stored.path) : []
  },
  // One active login per provider inside OpenCode's own database; nothing to select.
  accountEnv: async (_selection, base) => ({ ...base }),
  selectedAccount: () => ({ name: "default" }),
  credentialRevision: async (_name, env = process.env) => {
    const stored = databaseCredentials(env)
    if (!stored) return credentialFileFingerprint(authFile(env))
    return credentialFingerprint([
      stored.path,
      ...[...stored.credentials].map(([provider, credential]) => `${provider}:${credential.type}:${credential.access ?? ""}`),
    ])
  },
  accountUsage,
}
