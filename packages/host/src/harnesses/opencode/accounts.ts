import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { openCodeDatabasePaths } from "@mako/sessions"
import type { DatabaseSync } from "node:sqlite"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import type {
  AccountUsage,
  HarnessAccount,
  OpenCodeAuthType,
} from "../../contracts/accounts.js"
import {
  credentialFingerprint,
  principalFingerprint,
  readOptionalFile,
  jsonFields,
  jwtClaims,
  stringValue,
  valueFields,
} from "../accounts-common.js"
import type { JsonValue } from "../../contracts/json.js"
import type { ObservedAccountCapability } from "../account-capability.js"
import { chainFingerprint, instant, objectValue, placeSecret, removeSecret, WITHHELD, type CloudSignInCapability, type CloudSignInMirror } from "../cloud-sign-in.js"
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

function parseCredentials(fields: ReadonlyMap<string, JsonValue>): Map<string, OpenCodeCredential> {
  const credentials = new Map<string, OpenCodeCredential>()
  for (const [providerId, value] of fields) {
    const credential = parseCredential(value)
    if (credential) credentials.set(providerId, credential)
  }
  return credentials
}

const OpenCodePrincipals = z.json().transform((value) => principals(parseCredentials(valueFields(value) ?? new Map())))

function principals(credentials: Map<string, OpenCodeCredential>): string[] {
  return [...credentials].map(([provider, credential]) => {
    const claims = jwtClaims(credential.access)
    return `${provider}:${credential.type}:${credential.accountId ?? claims.accountId ?? claims.email ?? ""}`
  })
}

const CredentialRow = z.object({ provider: z.string(), value: z.string() })

/** OpenCode 2's active login per provider: one row each in the database that also holds its sessions. */
function databaseCredentials(stores: NativeStores, env: NodeJS.ProcessEnv): { path: string; credentials: Map<string, OpenCodeCredential> } | null {
  for (const path of openCodeDatabasePaths(env)) {
    if (!existsSync(path)) continue
    let db: DatabaseSync | undefined
    try {
      db = stores.open(path, { timeout: 1_000 })
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

async function openCodeCredentials(stores: NativeStores, env: NodeJS.ProcessEnv = process.env): Promise<{ path: string; credentials: Map<string, OpenCodeCredential> } | null> {
  const stored = databaseCredentials(stores, env)
  if (stored) return stored
  const path = authFile(env)
  try {
    return { path, credentials: parseCredentials(jsonFields(await readFile(path, "utf8"))) }
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
      source: "model-provider",
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
  return accountsFrom(parseCredentials(jsonFields(contents)), path)
}

async function accountUsage(stores: NativeStores, providerId: string): Promise<AccountUsage> {
  const credential = (await openCodeCredentials(stores))?.credentials.get(providerId)
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

/** The method OpenCode's own import gives a provider's OAuth login (OpenCode 2.0). */
function openCodeMethod(provider: string): string {
  if (provider === "openai") return "chatgpt-browser"
  return ["github-copilot", "opencode", "xai"].includes(provider) ? "device" : "oauth"
}

interface CloudCredential {
  provider: string
  label: string
  /** OpenCode 2's own shape of the login, refresh token withheld. */
  value: Record<string, JsonValue>
}

/** OpenCode 1's `auth.json` entry, by type. */
const LegacyEntrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api"), key: z.string(), metadata: z.json().optional() }),
  z.object({ type: z.literal("wellknown"), token: z.string() }),
  z.object({ type: z.literal("oauth"), access: z.string(), refresh: z.json().optional(), expires: z.json().optional(), accountId: z.string().optional().catch(undefined) }),
])

/** OpenCode 2's login, by type. */
const LoginSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), key: z.string(), metadata: z.json().optional() }),
  z.object({ type: z.literal("oauth"), access: z.string(), expires: z.json().optional(), metadata: z.object({ accountID: z.string() }).optional().catch(undefined) }),
])

/** OpenCode 1's entry as OpenCode 2's: what its import of `auth.json` writes. */
function fromLegacy(provider: string, value: JsonValue | undefined): Record<string, JsonValue> | null {
  const parsed = LegacyEntrySchema.safeParse(value)
  if (!parsed.success) return null
  const entry = parsed.data
  switch (entry.type) {
    case "api": {
      const login = { type: "key", key: entry.key }
      return entry.metadata ? { ...login, metadata: entry.metadata } : login
    }
    case "wellknown":
      return { type: "key", key: entry.token }
    case "oauth": {
      const login = { type: "oauth", methodID: openCodeMethod(provider), refresh: entry.refresh ?? "", access: entry.access, expires: entry.expires ?? 0 }
      return entry.accountId === undefined ? login : { ...login, metadata: { accountID: entry.accountId } }
    }
  }
}

/** OpenCode 2's login as OpenCode 1's `auth.json` entry, which OpenCode 2 imports into a database it makes. */
function toLegacy(value: Record<string, JsonValue>): Record<string, JsonValue> | null {
  const parsed = LoginSchema.safeParse(value)
  if (!parsed.success) return null
  const login = parsed.data
  if (login.type === "key") {
    const entry = { type: "api", key: login.key }
    return login.metadata ? { ...entry, metadata: login.metadata } : entry
  }
  const entry = { type: "oauth", refresh: WITHHELD, access: login.access, expires: login.expires ?? 0 }
  return login.metadata ? { ...entry, accountId: login.metadata.accountID } : entry
}

/** The address an OAuth login was made with, from its access token. */
function loginEmail(value: Record<string, JsonValue>): string | undefined {
  const login = LoginSchema.safeParse(value)
  return login.success && login.data.type === "oauth" ? jwtClaims(login.data.access).email : undefined
}

function withheld(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return value.type === "oauth" ? { ...value, refresh: WITHHELD } : value
}

/**
 * A machine's OpenCode database, opened so a login it replaces or deletes is
 * overwritten in place rather than left readable in a free page.
 */
async function openLogins(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path, { timeout: 5_000 })
  db.exec("PRAGMA secure_delete = ON")
  return db
}

const CredentialRowsSchema = z.array(z.object({ provider: z.string(), label: z.string(), value: z.string() }))
const ACTIVE_CREDENTIALS = "SELECT integration_id AS provider, label, value FROM credential WHERE active = 1 AND integration_id IS NOT NULL ORDER BY integration_id"

/** Each provider's active login in an open OpenCode database, whole. */
function activeCredentials(db: DatabaseSync): CloudCredential[] {
  return CredentialRowsSchema.parse(db.prepare(ACTIVE_CREDENTIALS).all()).flatMap((row) => {
    const value = objectValue(JSON.parse(row.value))
    return value ? [{ provider: row.provider, label: row.label, value }] : []
  })
}

/** OpenCode 2's logins from the first database that has any, whole; null when none does. */
async function databaseLogins(env: NodeJS.ProcessEnv): Promise<{ path: string; credentials: CloudCredential[] } | null> {
  const { DatabaseSync } = await import("node:sqlite")
  for (const path of openCodeDatabasePaths(env)) {
    if (!existsSync(path)) continue
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path, { readOnly: true, timeout: 1_000 })
      const credentials = activeCredentials(db)
      if (credentials.length) return { path, credentials }
    } catch {
      // An older database has no credential table.
    } finally {
      db?.close()
    }
  }
  return null
}

const SecretSchema = z.union([
  z.object({ type: z.literal("oauth"), refresh: z.string() }).loose(),
  z.object({ type: z.literal("key"), key: z.string() }).loose(),
  z.object({ type: z.string() }).loose(),
])

/**
 * What names OpenCode's logins as one sign-in for Mako Cloud: each provider's refresh token or key, in provider order.
 * It changes when OpenCode refreshes a login, or a login or key changes here; Mako Cloud names it the same way.
 */
export function openCodeChainToken(payload: Record<string, JsonValue>): string | null {
  const credentials = z.array(z.object({ provider: z.string(), value: z.json() }).loose()).safeParse(payload.credentials)
  return credentials.success ? loginsToken(credentials.data) : null
}

function loginsToken(credentials: ReadonlyArray<{ provider: string; value: JsonValue }>): string | null {
  if (!credentials.length) return null
  return [...credentials]
    .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
    .map(({ provider, value }) => {
      const login = SecretSchema.safeParse(value)
      const secret = !login.success ? "" : "refresh" in login.data ? login.data.refresh : "key" in login.data ? login.data.key : login.data.type
      return `${provider}=${secret}`
    })
    .join("\n")
}

/**
 * OpenCode's own database. OpenCode reads each login again on every model call and refreshes one only within five
 * minutes of its expiry, holding no lock; a write in one transaction, over the logins it read, is what it runs on next.
 * With no lock it has no `hold`: ChatGPT's login lasts ten days, so no night's sleep lapses it.
 */
const openCodeMirror: CloudSignInMirror = {
  token: openCodeChainToken,
  principal(payload) {
    const accounts = z.array(z.object({ provider: z.string(), value: z.object({ metadata: z.object({ accountID: z.string() }).loose() }).loose() }).loose()).safeParse(payload.credentials)
    return accounts.success && accounts.data.length ? accounts.data.map(({ provider, value }) => `${provider}:${value.metadata.accountID}`).sort().join(",") : null
  },
  async write(env, chain, expected) {
    const credentials = z.array(z.object({ provider: z.string().min(1), label: z.string(), value: z.record(z.string(), z.json()) })).parse(chain.payload.credentials)
    const found = await databaseLogins(env)
    const path = found?.path ?? openCodeDatabasePaths(env).find((candidate) => existsSync(candidate))
    if (!path) throw new Error("OpenCode has no database on this Mac yet; run it once")
    const db = await openLogins(path)
    try {
      db.exec("BEGIN IMMEDIATE")
      const held = loginsToken(activeCredentials(db))
      if ((held ? chainFingerprint(held) : null) !== expected) {
        db.exec("ROLLBACK")
        return false
      }
      const now = Date.now()
      for (const { provider, label, value } of credentials) {
        const text = JSON.stringify(value)
        const updated = db.prepare("UPDATE credential SET value = ?, time_updated = ? WHERE integration_id = ? AND active = 1").run(text, now, provider)
        if (Number(updated.changes) === 0)
          db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)")
            .run(`cred_${now.toString(16)}${randomBytes(8).toString("hex")}`, provider, label, text, now, now)
      }
      db.exec("COMMIT")
      return true
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    } finally {
      db.close()
    }
  },
}

async function cloudCredentials(env: NodeJS.ProcessEnv): Promise<CloudCredential[]> {
  const found = await databaseLogins(env)
  if (found) return found.credentials.map((credential) => ({ ...credential, value: withheld(credential.value) }))
  const legacy = await readOptionalFile(authFile(env))
  if (legacy === null) return []
  return Object.entries(objectValue(JSON.parse(legacy)) ?? {}).flatMap(([provider, entry]) => {
    const value = fromLegacy(provider, entry)
    return value ? [{ provider, label: provider, value: withheld(value) }] : []
  })
}

/**
 * OpenCode's active login for each provider. OpenCode 2 reads them from the
 * database that also holds its sessions, and imports `auth.json` only when it
 * makes that database: a machine whose OpenCode hasn't run yet is given the
 * file, and one whose has gets each login written to its database. That
 * database is on disk, as OpenCode reads its logins nowhere else.
 */
export const openCodeCloudSignIn: CloudSignInCapability = {
  mirror: openCodeMirror,
  /** OpenCode 2's logins whole, refresh tokens included; OpenCode 1's `auth.json` isn't shared this way. */
  async chain(env) {
    const found = await databaseLogins(env)
    if (!found) return null
    const label = found.credentials.map((credential) => loginEmail(credential.value)).find(Boolean) ?? null
    return { label, payload: { credentials: found.credentials.map((credential) => ({ ...credential })) } }
  },
  async export(env) {
    const credentials = await cloudCredentials(env)
    if (!credentials.length) return null
    const lapses = credentials.flatMap((credential) => (credential.value.type === "oauth" ? [instant(credential.value.expires)] : []))
    const expiresAt = lapses.some((lapse) => lapse === null) ? null : lapses.reduce<string | null>((first, lapse) => (!first || (lapse && lapse < first) ? lapse : first), null)
    const label = credentials.map((credential) => loginEmail(credential.value)).find(Boolean) ?? null
    return { label, expiresAt, payload: { credentials: credentials.map((credential) => ({ ...credential })) } }
  },
  async remove(place) {
    const env = { ...process.env, HOME: place.home, XDG_DATA_HOME: join(place.home, ".local", "share") }
    let had = false
    for (const path of openCodeDatabasePaths(env)) {
      if (!existsSync(path)) continue
      const db = await openLogins(path)
      try {
        // A machine's OpenCode has only the logins its account sent.
        had = Number(db.prepare("DELETE FROM credential").run().changes) > 0 || had
        // OpenCode's own updates of a login leave its earlier values in free pages, which rebuilding the file drops;
        // emptying the log drops the copies written there.
        db.exec("VACUUM")
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch (error) {
        if (!(error instanceof Error && /no such table/.test(error.message))) throw error
      } finally {
        db.close()
      }
    }
    return (await removeSecret(place, join(".local", "share", "opencode", "auth.json"))) || had
  },
  async install(payload, place) {
    const credentials = z.array(z.object({ provider: z.string().min(1), label: z.string(), value: z.record(z.string(), z.json()) })).parse(payload.credentials)
    const env = { ...process.env, HOME: place.home, XDG_DATA_HOME: join(place.home, ".local", "share") }
    for (const path of openCodeDatabasePaths(env)) {
      if (!existsSync(path)) continue
      const db = await openLogins(path)
      try {
        db.prepare("SELECT 1 FROM credential LIMIT 1").all()
        const now = Date.now()
        db.exec("BEGIN IMMEDIATE")
        for (const { provider, label, value } of credentials) {
          const text = JSON.stringify(value)
          const updated = db.prepare("UPDATE credential SET value = ?, time_updated = ? WHERE integration_id = ? AND active = 1").run(text, now, provider)
          if (Number(updated.changes) === 0)
            db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)")
              .run(`cred_${now.toString(16)}${randomBytes(8).toString("hex")}`, provider, label, text, now, now)
        }
        db.exec("COMMIT")
        return
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK")
        // A database without the credential table is OpenCode 1's: it reads `auth.json`.
        if (!(error instanceof Error && /no such table/.test(error.message))) throw error
      } finally {
        db.close()
      }
    }
    const legacy = Object.fromEntries(credentials.flatMap(({ provider, value }) => {
      const entry = toLegacy(value)
      return entry ? [[provider, entry]] : []
    }))
    await placeSecret(place, join(".local", "share", "opencode", "auth.json"), JSON.stringify(legacy, null, 2))
  },
}

/** OpenCode's logins, read from its database as `stores` opens it. */
export function openCodeAccountCapability(stores: NativeStores): ObservedAccountCapability {
  return {
    provider: "opencode",
    mode: "observed",
    label: "OpenCode",
    loginCommand: "opencode auth login",
    readOnlyReason:
      "OpenCode keeps its logins inside the database that holds its sessions, so a second OpenCode login would split your OpenCode history.",
    listAccounts: async () => {
      const stored = await openCodeCredentials(stores)
      return stored ? accountsFrom(stored.credentials, stored.path) : []
    },
    // One active login per provider inside OpenCode's own database; nothing to select.
    accountEnv: async (_selection, base) => ({ ...base }),
    selectedAccount: () => ({ name: "default" }),
    // The access token is refreshed in place; a login's account is what names it.
    credentialRevision: async (_name, env = process.env) => {
      const stored = databaseCredentials(stores, env)
      if (stored) return credentialFingerprint([stored.path, ...principals(stored.credentials)])
      const contents = await readOptionalFile(authFile(env))
      return credentialFingerprint([authFile(env), principalFingerprint(contents, OpenCodePrincipals)])
    },
    accountUsage: (providerId) => accountUsage(stores, providerId),
    cloudSignIn: openCodeCloudSignIn,
  }
}
