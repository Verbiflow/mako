import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"

/**
 * Mako's own record of the Cursor API key the SDK runs under.
 *
 * The SDK will read `~/.cursor/sdk/auth.json` on its own, but that file is
 * plain text with the key in it. Mako keeps the key it minted or was given
 * encrypted through Electron's `safeStorage` — the same OS keychain wrapping
 * the commit-message model keys use — beside the SDK state root, so the
 * installed app and a development host read one credential, and hands it to
 * each SDK child as `CURSOR_API_KEY` in that child's environment. Nothing
 * here ever reaches the renderer, a log, or a settings snapshot: the row in
 * Settings shows the account and the key's name, never its value.
 */
export interface CursorKeyEncryption {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

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
})
export type StoredCursorCredential = z.infer<typeof StoredCursorCredentialSchema>

/** A pasted key, checked for shape before anything is spawned with it. */
export function parseCursorApiKey(value: string): string {
  const parsed = ApiKeySchema.safeParse(value)
  if (!parsed.success) throw new Error("Paste the whole API key on one line; Cursor's keys are at least 16 characters.")
  return parsed.data
}

/** Where the credential file lives: beside the SDK's agents, one per user. */
export function cursorCredentialPath(stateRoot: string): string {
  return join(stateRoot, "credential.bin")
}

export class CursorCredentialStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CursorCredentialStoreError"
  }
}

export class CursorCredentialStore {
  private readonly path: string
  private readonly encryption: CursorKeyEncryption
  private writing: Promise<unknown> = Promise.resolve()

  constructor(path: string, encryption: CursorKeyEncryption) {
    this.path = path
    this.encryption = encryption
  }

  /** Whether the OS can wrap a key for this host; without it nothing is saved. */
  secure(): Promise<boolean> {
    return this.encryption.available()
  }

  /** The saved credential, `null` when none is saved. Throws when one exists but cannot be opened. */
  async load(): Promise<StoredCursorCredential | null> {
    await this.writing
    let bytes: Buffer
    try {
      const info = await stat(this.path)
      if (info.size > 64 * 1024) throw new CursorCredentialStoreError("The saved Cursor credential file is not one Mako wrote.")
      bytes = await readFile(this.path)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
      throw error instanceof CursorCredentialStoreError
        ? error
        : new CursorCredentialStoreError("The saved Cursor credential could not be read.")
    }
    if (!(await this.encryption.available()))
      throw new CursorCredentialStoreError(
        "The saved Cursor key is locked: this host has no access to the system keychain. Unlock it or sign in again."
      )
    try {
      return StoredCursorCredentialSchema.parse(JSON.parse(await this.encryption.decrypt(bytes)))
    } catch {
      throw new CursorCredentialStoreError(
        "The saved Cursor key could not be opened with this keychain. Sign in again to replace it."
      )
    }
  }

  async save(credential: StoredCursorCredential): Promise<void> {
    if (!(await this.encryption.available()))
      throw new CursorCredentialStoreError(
        "Mako cannot store the key securely on this machine: the system keychain is unavailable."
      )
    const payload = await this.encryption.encrypt(JSON.stringify(StoredCursorCredentialSchema.parse(credential)))
    const task = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, payload, { mode: 0o600 })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.writing = task.catch(() => undefined)
    await task
  }

  async clear(): Promise<void> {
    const task = this.writing.then(() => rm(this.path, { force: true }))
    this.writing = task.catch(() => undefined)
    await task
  }
}

/**
 * Electron's `safeStorage`, reached lazily so this module also loads in a
 * plain Node test. A `basic_text` backend is not encryption and is refused.
 */
export function electronKeyEncryption(): CursorKeyEncryption {
  const electron = import("electron")
  return {
    async available() {
      const { safeStorage } = await electron
      return (
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text")
      )
    },
    async encrypt(value) {
      return (await electron).safeStorage.encryptString(value)
    },
    async decrypt(value) {
      return (await electron).safeStorage.decryptString(value)
    },
  }
}
