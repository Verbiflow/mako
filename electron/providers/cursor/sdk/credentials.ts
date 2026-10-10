import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import { legacyNamesIn, SecretLocked, type LegacyFiles, type SecretRecord, type Secrets } from "../../../secrets.js"

/**
 * Mako's own record of the Cursor API key the SDK runs under.
 *
 * The SDK will read `~/.cursor/sdk/auth.json` on its own, but that file is
 * plain text with the key in it. Mako keeps the key it minted or was given
 * as a saved key in the host's `Secrets`, which every host of this user
 * shares, so the installed app and a development host read one credential,
 * and hands it to each SDK child as `CURSOR_API_KEY` in that child's
 * environment. Nothing here ever reaches the renderer, a log, or a settings
 * snapshot: the row in Settings shows the account and the key's name, never
 * its value.
 */

/** How a key came to be stored: minted by a browser sign-in, or pasted from the dashboard. */
export const CURSOR_CREDENTIAL_METHODS = ["browser", "pasted"] as const
export type CursorCredentialMethod = (typeof CURSOR_CREDENTIAL_METHODS)[number]

const ApiKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/, "An API key is one line of printable characters")

export const StoredCursorCredentialSchema = z.object({
  version: z.literal(1),
  apiKey: ApiKeySchema,
  method: z.enum(CURSOR_CREDENTIAL_METHODS),
  /** Public account facts learned when the key was verified; shown in Settings. */
  email: z.string().optional(),
  keyName: z.string().optional(),
  /** ISO time the key lapses, when the provider said. */
  expiresAt: z.string().optional(),
  savedAt: z.string(),
  /** Opaque identity of this saved credential, never a digest of its secret. */
  revision: z.string().uuid().optional(),
})
export type StoredCursorCredential = z.infer<typeof StoredCursorCredentialSchema>

/** A pasted key, checked for shape before anything is spawned with it. */
export function parseCursorApiKey(value: string): string {
  const parsed = ApiKeySchema.safeParse(value)
  if (!parsed.success) throw new Error("Paste the whole API key on one line; Cursor's keys are at least 16 characters.")
  return parsed.data
}

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Where older builds sealed Cursor's keys, for the host's `Secrets` to take
 * over: `credential.bin` beside the SDK's agents, and `accounts/<name>.bin`
 * for each account added in Mako.
 */
export function cursorLegacyFiles(stateRoot: string): LegacyFiles {
  const accounts = join(stateRoot, "accounts")
  return {
    path(kind, name) {
      if (kind !== "saved-key") return null
      if (name === CURSOR_SECRET) return join(stateRoot, "credential.bin")
      const account = name.startsWith(`${CURSOR_SECRET}/`) ? name.slice(CURSOR_SECRET.length + 1) : ""
      return ACCOUNT_NAME.test(account) ? join(accounts, `${account}.bin`) : null
    },
    async names(kind) {
      if (kind !== "saved-key") return []
      return (await legacyNamesIn(accounts, ".bin")).map((account) => `${CURSOR_SECRET}/${account}`)
    },
  }
}

export class CursorCredentialStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CursorCredentialStoreError"
  }
}

/** The record Cursor's own sign-in is kept under; an added account's is `cursor/<account>`. */
export const CURSOR_SECRET = "cursor"

export class CursorCredentialStore {
  private readonly secrets: Secrets
  private readonly name: string

  constructor(secrets: Secrets, name = CURSOR_SECRET) {
    this.secrets = secrets
    this.name = name
  }

  /** Whether the OS can wrap a key for this host; without it nothing is saved. */
  secure(): Promise<boolean> {
    return this.secrets.durable()
  }

  /** The saved credential, `null` when none is saved. Throws when one exists but cannot be opened. */
  async load(): Promise<StoredCursorCredential | null> {
    let record: SecretRecord | null
    try {
      record = await this.secrets.read("saved-key", this.name)
    } catch (error) {
      throw new CursorCredentialStoreError(
        error instanceof SecretLocked && error.reason === "unavailable"
          ? "The saved Cursor key is locked: this host has no access to the system keychain. Unlock it or sign in again."
          : "The saved Cursor key could not be opened with this keychain. Sign in again to replace it."
      )
    }
    if (!record) return null
    try {
      return StoredCursorCredentialSchema.parse(JSON.parse(record.value))
    } catch {
      throw new CursorCredentialStoreError("The saved Cursor credential is not one Mako wrote. Sign in again to replace it.")
    }
  }

  async save(credential: StoredCursorCredential): Promise<void> {
    if (!(await this.secrets.durable()))
      throw new CursorCredentialStoreError(
        "Mako cannot store the key securely on this machine: the system keychain is unavailable."
      )
    const parsed = StoredCursorCredentialSchema.parse(credential)
    const expiresAt = parsed.expiresAt && Number.isFinite(Date.parse(parsed.expiresAt)) ? parsed.expiresAt : null
    await this.secrets.write("saved-key", this.name, JSON.stringify({ ...parsed, revision: randomUUID() }), { expiresAt })
  }

  async clear(): Promise<void> {
    await this.secrets.delete("saved-key", this.name)
  }
}

/**
 * The keys of Cursor accounts added in Mako, one record per account, so
 * signing in another account never replaces the first.
 */
export class CursorAccountKeys {
  private readonly secrets: Secrets
  private readonly stores = new Map<string, CursorCredentialStore>()

  constructor(secrets: Secrets) {
    this.secrets = secrets
  }

  store(name: string): CursorCredentialStore {
    if (!ACCOUNT_NAME.test(name)) throw new Error("Invalid account name")
    let store = this.stores.get(name)
    if (!store) {
      store = new CursorCredentialStore(this.secrets, `${CURSOR_SECRET}/${name}`)
      this.stores.set(name, store)
    }
    return store
  }

  async names(): Promise<string[]> {
    const prefix = `${CURSOR_SECRET}/`
    return (await this.secrets.list("saved-key"))
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .sort()
  }
}
