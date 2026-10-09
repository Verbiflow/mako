import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { z } from "zod"
import { KeychainUnavailable, type SecretEncryption } from "./secure-storage.js"

/**
 * Every secret the host keeps, of every kind, in one store with one record
 * and one set of rules (Wayfinder: one secret system). No domain reaches the
 * keychain or a credential file itself; each is handed a `Secrets`.
 *
 * On the Mac the values are sealed with AES-256-GCM under one data key the
 * keychain wraps. In the cloud the machine agent delivers the same records to
 * tmpfs. A test uses the in-memory store. One contract test holds all three
 * to the same behaviour (`scripts/test-secrets.ts`).
 */

export const SECRET_KINDS = [
  /** A key the person saved in Settings: the Cursor key, a utility model's key. */
  "saved-key",
  /** A harness's own sign-in, declared by its driver. */
  "harness-sign-in",
  /** A file a recipe carries into a checkout, like a project's `.env`. */
  "credentials-file",
  /** A site's cookies and storage for the project's sign-in browser. */
  "browser-sign-in",
  /** This host's own sign-in to Mako's cloud. */
  "mako-sign-in",
] as const
export type SecretKind = (typeof SECRET_KINDS)[number]

const SEGMENT = "[a-z0-9][a-z0-9._-]{0,63}"
const NamePattern = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,3}$`)
const KindSchema = z.enum(SECRET_KINDS)
const NameSchema = z
  .string()
  .regex(
    NamePattern,
    "A secret's name is up to four lowercase segments joined by /"
  )
const ExpirySchema = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "An expiry is an ISO time"
  )
/** Big enough for a browser sign-in's cookies; small enough to read whole. */
const MAX_VALUE_BYTES = 1024 * 1024

/** What a secret is for, never its value: safe to list, log and show. */
export interface SecretListing {
  readonly kind: SecretKind
  readonly name: string
  /** Opaque and new on every write; never derived from the value. */
  readonly version: string
  readonly savedAt: string
  /** When the provider said the value lapses; `null` when it didn't. */
  readonly expiresAt: string | null
}

export interface SecretRecord extends SecretListing {
  readonly value: string
}

export interface SecretWrite {
  /** When the provider said the value lapses. */
  expiresAt?: string | null
}

export interface Secrets {
  /** Whether a write outlives this process: the keychain answers, or the cloud's store is mounted. */
  durable(): Promise<boolean>
  /** The record, or `null` when none is saved. Throws {@link SecretLocked} when one is saved but can't be opened here. */
  read(kind: SecretKind, name: string): Promise<SecretRecord | null>
  /** Replace the record with a new version. Throws {@link SecretUnavailable} when nothing can be kept. */
  write(
    kind: SecretKind,
    name: string,
    value: string,
    options?: SecretWrite
  ): Promise<SecretRecord>
  delete(kind: SecretKind, name: string): Promise<void>
  /** Every saved record of this kind, by name, without values. */
  list(kind: SecretKind): Promise<SecretListing[]>
}

/**
 * A secret is saved but this host can't open it. `unavailable`: the keychain
 * doesn't answer (locked, or no login keychain). `unreadable`: it answered,
 * but the record was sealed under another key, or was changed.
 */
export class SecretLocked extends Error {
  readonly reason: "unavailable" | "unreadable"
  constructor(reason: "unavailable" | "unreadable") {
    super(
      reason === "unavailable"
        ? "The keychain that opens this secret is unavailable"
        : "This secret can't be opened with this keychain"
    )
    this.name = "SecretLocked"
    this.reason = reason
  }
}

export class SecretUnavailable extends Error {
  constructor() {
    super(
      "Nothing can be kept securely on this host: the keychain is unavailable"
    )
    this.name = "SecretUnavailable"
  }
}

function checked(kind: SecretKind, name: string): void {
  KindSchema.parse(kind)
  NameSchema.parse(name)
}

function written(
  kind: SecretKind,
  name: string,
  value: string,
  options: SecretWrite
): SecretRecord {
  checked(kind, name)
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES)
    throw new Error("A secret's value is at most 1 MiB")
  const expiresAt = options.expiresAt
    ? ExpirySchema.parse(options.expiresAt)
    : null
  return {
    kind,
    name,
    version: randomUUID(),
    savedAt: new Date().toISOString(),
    value,
    expiresAt,
  }
}

function listing({
  kind,
  name,
  version,
  savedAt,
  expiresAt,
}: SecretListing): SecretListing {
  return { kind, name, version, savedAt, expiresAt }
}

/** Records in memory, gone with the process: for tests, and for a host that must not write its profile. */
export function memorySecrets({
  durable = true,
}: { durable?: boolean } = {}): Secrets {
  const records = new Map<string, SecretRecord>()
  const key = (kind: SecretKind, name: string) => `${kind}\0${name}`
  return {
    durable: async () => durable,
    async read(kind, name) {
      checked(kind, name)
      return records.get(key(kind, name)) ?? null
    },
    async write(kind, name, value, options = {}) {
      const record = written(kind, name, value, options)
      if (!durable) throw new SecretUnavailable()
      records.set(key(kind, name), record)
      return record
    },
    async delete(kind, name) {
      checked(kind, name)
      records.delete(key(kind, name))
    },
    async list(kind) {
      KindSchema.parse(kind)
      return [...records.values()]
        .filter((record) => record.kind === kind)
        .map(listing)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}

/**
 * How a file store keeps values. The record's kind, name and version are
 * bound into the seal, so a record copied over another, renamed, or given
 * another version's label doesn't open.
 */
export interface SecretSealer {
  readonly format: "aes-256-gcm" | "plain"
  available(): Promise<boolean>
  seal(value: string, context: string): Promise<string>
  open(sealed: string, context: string): Promise<string>
}

/** The data key a sealer uses, from wherever this host keeps it. */
export interface SecretKey {
  available(): Promise<boolean>
  /** The 32-byte key; with `create`, made on first use. `null` when none exists and `create` is false. */
  key(create: boolean): Promise<Buffer | null>
}

export function aesSealer(source: SecretKey): SecretSealer {
  return {
    format: "aes-256-gcm",
    available: () => source.available(),
    async seal(value, context) {
      const key = await source.key(true)
      if (!key) throw new SecretUnavailable()
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      cipher.setAAD(Buffer.from(context))
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      return [iv, cipher.getAuthTag(), data]
        .map((part) => part.toString("base64url"))
        .join(".")
    },
    async open(sealed, context) {
      if (!(await source.available())) throw new SecretLocked("unavailable")
      const key = await source.key(false)
      if (!key) throw new SecretLocked("unreadable")
      const [iv, tag, data, ...extra] = sealed
        .split(".")
        .map((part) => Buffer.from(part, "base64url"))
      if (
        !iv ||
        !tag ||
        !data ||
        extra.length ||
        iv.length !== 12 ||
        tag.length !== 16
      )
        throw new SecretLocked("unreadable")
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv)
        decipher.setAAD(Buffer.from(context))
        decipher.setAuthTag(tag)
        return Buffer.concat([
          decipher.update(data),
          decipher.final(),
        ]).toString("utf8")
      } catch {
        throw new SecretLocked("unreadable")
      }
    },
  }
}

/** Values kept as they are, for tmpfs in the cloud: memory the machine agent filled, never a disk. */
export function plainSealer(): SecretSealer {
  return {
    format: "plain",
    available: async () => true,
    seal: async (value) => value,
    open: async (sealed) => sealed,
  }
}

/**
 * The data key's file: the key wrapped by the keychain, and a hash that
 * names it, so a key handed over by another process can be checked without
 * the keychain. The hash of a random 256-bit key gives nothing away.
 */
const KeyFileSchema = z.object({
  format: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  wrapped: z.string().min(1),
})
type KeyFile = z.infer<typeof KeyFileSchema>

function keyId(key: Buffer): string {
  return createHash("sha256")
    .update("mako-data-key\0")
    .update(key)
    .digest("base64url")
}

async function readKeyFile(path: string): Promise<KeyFile | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null
    throw new SecretLocked("unreadable")
  }
  try {
    return KeyFileSchema.parse(JSON.parse(text))
  } catch {
    throw new SecretLocked("unreadable")
  }
}

/**
 * A random data key, kept wrapped by the keychain through `encryption`
 * (Electron's `safeStorage`, or its keychain item read in this process: see
 * `chromiumSafeStorage`). A keychain that can't answer leaves the key
 * unavailable rather than unreadable. It is unwrapped
 * once per process, so every secret after the first costs no keychain call.
 * Two hosts sharing the user's store race to make it safely: the loser
 * reads the winner's.
 */
export function wrappedKey(
  path: string,
  encryption: SecretEncryption
): SecretKey {
  let known: Buffer | undefined
  let loading: Promise<Buffer | null> | undefined
  let creating: Promise<Buffer> | undefined
  const unwrap = async (): Promise<Buffer | null> => {
    const file = await readKeyFile(path)
    if (!file) return null
    let key: Buffer
    try {
      key = Buffer.from(
        await encryption.decrypt(Buffer.from(file.wrapped, "base64")),
        "base64"
      )
    } catch (error) {
      throw new SecretLocked(error instanceof KeychainUnavailable ? "unavailable" : "unreadable")
    }
    if (key.length !== 32 || keyId(key) !== file.id)
      throw new SecretLocked("unreadable")
    return key
  }
  const make = async (): Promise<Buffer> => {
    const key = randomBytes(32)
    let wrapped: Buffer
    try {
      wrapped = await encryption.encrypt(key.toString("base64"))
    } catch (error) {
      if (error instanceof KeychainUnavailable) throw new SecretUnavailable()
      throw error
    }
    const file: KeyFile = {
      format: 1,
      id: keyId(key),
      wrapped: wrapped.toString("base64"),
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // Written whole, then linked into place: a host that loses the race never reads half a key.
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(file), {
        mode: 0o600,
        flag: "wx",
      })
      await link(temporary, path)
      return key
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        const theirs = await unwrap()
        if (theirs) return theirs
      }
      throw error
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return {
    available: () => encryption.available(),
    async key(create) {
      if (known) return known
      loading ??= unwrap().finally(() => {
        loading = undefined
      })
      const found = await loading
      if (found) return (known = found)
      if (!create) return null
      if (!(await encryption.available())) throw new SecretUnavailable()
      creating ??= make().finally(() => {
        creating = undefined
      })
      return (known = await creating)
    },
  }
}

export interface HandedKey extends SecretKey {
  held(): boolean
  /** Whether the key is held, waiting up to `ms` for it to be handed over. */
  arrival(ms: number): Promise<boolean>
  /** Take the key; refused unless the key file at `path` names it. */
  offer(key: Buffer): Promise<void>
}

/**
 * The data key handed over by the desktop app, whose `safeStorage` reaches
 * the keychain without asking, to a host in Node mode, which has none. It is
 * kept in this process's memory only, and never made here: the process that
 * hands it over makes it if the store has none.
 */
export function handedKey(path: string): HandedKey {
  let held: Buffer | undefined
  const waiting = new Set<() => void>()
  return {
    available: async () => held !== undefined,
    async key(create) {
      if (held) return held
      if (create) throw new SecretUnavailable()
      return null
    },
    held: () => held !== undefined,
    arrival(ms) {
      if (held || ms <= 0) return Promise.resolve(held !== undefined)
      return new Promise((resolve) => {
        const arrived = () => {
          clearTimeout(timer)
          resolve(true)
        }
        const timer = setTimeout(() => {
          waiting.delete(arrived)
          resolve(held !== undefined)
        }, ms)
        waiting.add(arrived)
      })
    },
    async offer(key) {
      if (key.length !== 32) throw new Error("A data key is 32 bytes")
      const file = await readKeyFile(path).catch(() => {
        throw new Error("This store's data key file can't be read")
      })
      if (!file) throw new Error("This store has no data key yet")
      if (
        !timingSafeEqual(
          Buffer.from(keyId(key)),
          Buffer.from(file.id)
        )
      )
        throw new Error("That isn't this store's data key")
      held = Buffer.from(key)
      for (const arrived of waiting) arrived()
      waiting.clear()
    },
  }
}

const FileRecordSchema = z.object({
  format: z.literal(1),
  sealer: z.enum(["aes-256-gcm", "plain"]),
  kind: KindSchema,
  name: NameSchema,
  version: z.string().uuid(),
  savedAt: z.string(),
  expiresAt: ExpirySchema.nullable(),
  sealed: z.string(),
})
type FileRecord = z.infer<typeof FileRecordSchema>
const MAX_FILE_BYTES = 2 * MAX_VALUE_BYTES

function sealContext({
  kind,
  name,
  version,
}: Pick<SecretListing, "kind" | "name" | "version">): string {
  return `mako-secret\0${kind}\0${name}\0${version}`
}

/**
 * One file per record at `<root>/<kind>/<name>.json`, mode 0600, replaced by
 * rename so a reader sees the old record or the new one. What a record is for
 * stays readable, so listing never asks the keychain; only the value is sealed.
 * A record sealed some other way than this store's is never opened: a plain
 * record dropped into the Mac's store is not trusted as a secret.
 */
export function fileSecrets(root: string, sealer: SecretSealer): Secrets {
  const pathOf = (kind: SecretKind, name: string) =>
    join(root, kind, ...`${name}.json`.split("/"))
  let writes: Promise<unknown> = Promise.resolve()
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writes.then(task)
    writes = next.catch(() => undefined)
    return next
  }

  const load = async (
    kind: SecretKind,
    name: string
  ): Promise<FileRecord | null> => {
    const path = pathOf(kind, name)
    let text: string
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES)
        throw new SecretLocked("unreadable")
      text = await readFile(path, "utf8")
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null
      throw error instanceof SecretLocked
        ? error
        : new SecretLocked("unreadable")
    }
    const parsed = FileRecordSchema.safeParse(JSON.parse(text))
    if (
      !parsed.success ||
      parsed.data.kind !== kind ||
      parsed.data.name !== name
    )
      throw new SecretLocked("unreadable")
    return parsed.data
  }

  return {
    durable: () => sealer.available(),
    async read(kind, name) {
      checked(kind, name)
      await writes
      let stored: FileRecord | null
      try {
        stored = await load(kind, name)
      } catch (error) {
        throw error instanceof SecretLocked
          ? error
          : new SecretLocked("unreadable")
      }
      if (!stored) return null
      if (stored.sealer !== sealer.format) throw new SecretLocked("unreadable")
      return {
        ...listing(stored),
        value: await sealer.open(stored.sealed, sealContext(stored)),
      }
    },
    async write(kind, name, value, options = {}) {
      const record = written(kind, name, value, options)
      if (!(await sealer.available())) throw new SecretUnavailable()
      const sealed = await sealer.seal(value, sealContext(record))
      const file: FileRecord = {
        format: 1,
        sealer: sealer.format,
        ...listing(record),
        sealed,
      }
      const path = pathOf(kind, name)
      await queued(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(file), {
            mode: 0o600,
            flag: "wx",
          })
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      })
      return record
    },
    async delete(kind, name) {
      checked(kind, name)
      await queued(() => rm(pathOf(kind, name), { force: true }))
    },
    async list(kind) {
      KindSchema.parse(kind)
      await writes
      const directory = join(root, kind)
      const files = await readdir(directory, { recursive: true }).catch(
        () => []
      )
      const found: SecretListing[] = []
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        const name = file.slice(0, -".json".length).split(sep).join("/")
        if (!NamePattern.test(name)) continue
        const stored = await load(kind, name).catch(() => null)
        if (!stored) continue
        found.push(listing(stored))
      }
      return found.sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}

/**
 * Where older builds kept a domain's secrets, each sealed by `safeStorage` in
 * a file of its own. Each domain declares its own; the host combines them.
 */
export interface LegacyFiles {
  /** The older file for this record, or `null` when there never was one. */
  path(kind: SecretKind, name: string): string | null
  /** The names of this kind older builds saved. */
  names(kind: SecretKind): Promise<string[]>
}

export interface LegacySecretFiles extends LegacyFiles {
  /** The keychain that opened them. */
  encryption: SecretEncryption
}

/** Every domain's older files, as one. */
export function legacyFiles(sources: readonly LegacyFiles[]): LegacyFiles {
  return {
    path: (kind, name) =>
      sources
        .map((source) => source.path(kind, name))
        .find((path) => path !== null) ?? null,
    names: async (kind) =>
      (await Promise.all(sources.map((source) => source.names(kind)))).flat(),
  }
}

/** The names older builds saved in `directory` as `<name><extension>`. */
export async function legacyNamesIn(
  directory: string,
  extension: string
): Promise<string[]> {
  const entries = await readdir(directory).catch(() => [])
  return entries
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => entry.slice(0, -extension.length))
}

/**
 * The store, taking over each older file the first time its record is asked
 * for: the value moves into a record and the file is removed. While the
 * keychain can't open the file it stays where it is, and reading it says the
 * secret is locked, as the older build did. A record saved since wins and the
 * older file is dropped.
 */
export function adoptingLegacy(
  secrets: Secrets,
  legacy: LegacySecretFiles
): Secrets {
  const adopted = new Set<string>()
  const adopting = new Map<string, Promise<void>>()
  const adopt = (kind: SecretKind, name: string): Promise<void> => {
    const key = `${kind}\0${name}`
    if (adopted.has(key)) return Promise.resolve()
    let running = adopting.get(key)
    if (!running) {
      running = (async () => {
        try {
          await take(kind, name)
          adopted.add(key)
        } finally {
          adopting.delete(key)
        }
      })()
      adopting.set(key, running)
    }
    return running
  }
  const take = async (kind: SecretKind, name: string): Promise<void> => {
    const path = legacy.path(kind, name)
    if (!path) return
    let sealed: Buffer
    try {
      sealed = await readFile(path)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return
      throw new SecretLocked("unreadable")
    }
    if (await secrets.read(kind, name)) {
      await rm(path, { force: true })
      return
    }
    if (!(await legacy.encryption.available()))
      throw new SecretLocked("unavailable")
    let value: string
    try {
      value = await legacy.encryption.decrypt(sealed)
    } catch (error) {
      throw new SecretLocked(error instanceof KeychainUnavailable ? "unavailable" : "unreadable")
    }
    await secrets.write(kind, name, value)
    await rm(path, { force: true })
  }
  return {
    durable: () => secrets.durable(),
    async read(kind, name) {
      checked(kind, name)
      await adopt(kind, name)
      return secrets.read(kind, name)
    },
    async write(kind, name, value, options) {
      const record = await secrets.write(kind, name, value, options)
      const path = legacy.path(kind, name)
      if (path) await rm(path, { force: true })
      adopted.add(`${kind}\0${name}`)
      return record
    },
    async delete(kind, name) {
      checked(kind, name)
      const path = legacy.path(kind, name)
      if (path) await rm(path, { force: true })
      await secrets.delete(kind, name)
      adopted.add(`${kind}\0${name}`)
    },
    async list(kind) {
      const waiting: SecretListing[] = []
      for (const name of await legacy.names(kind)) {
        if (!NamePattern.test(name)) continue
        await adopt(kind, name).catch(() => {
          waiting.push({
            kind,
            name,
            version: "legacy",
            savedAt: "",
            expiresAt: null,
          })
        })
      }
      const saved = await secrets.list(kind)
      const names = new Set(saved.map((entry) => entry.name))
      return [
        ...saved,
        ...waiting.filter((entry) => !names.has(entry.name)),
      ].sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}
