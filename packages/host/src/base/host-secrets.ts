import { join, resolve } from "node:path"
import { heavy } from "./heavy-packages.js"
import type { HostEnvironment } from "./host-environment.js"
import { processKeychain } from "./keychain.js"
import { onMac } from "./platform.js"
import { adoptingLegacy, aesSealer, fileKey, fileSecrets, handedKey, legacyFiles, memorySecrets, wrappedKey, type LegacyFiles, type SecretKey, type SecretKind, type Secrets } from "./secrets.js"
import { chromiumSafeStorage, type SecretEncryption } from "./secure-storage.js"
import { GrantedSecrets } from "./secret-grants.js"
import type { LocalBorrowing } from "./local-borrowing.js"

/** How long the host waits after it starts for the desktop's handover before reading the keychain itself. */
const HANDOVER_GRACE_MS = 5_000

export interface HostSecretsInput {
  /** `HostEnvironment.userRoot`: the store is `<userRoot>/secrets`. */
  userRoot: string
  /**
   * The keychain item older builds' `safeStorage` used, read in this process
   * (`chromiumSafeStorage`); none off macOS.
   */
  keychain: SecretEncryption
  /** Each domain's older files; read as they are when a record is first asked for. */
  legacy: readonly LegacyFiles[]
  /** Until when (epoch ms) a read waits for the desktop's handover before asking `keychain`. */
  handoverUntil?: number
  /**
   * The data key's own file, for a machine no desktop runs on (`secretKeyFile`): used when `keychain` can't answer,
   * and no handover is waited for.
   */
  keyFile?: string
}

/**
 * How the host gets its data key from the desktop app, whose `safeStorage`
 * has it, on the host's private socket (`/secret-key`).
 */
export interface SecretKeyHandover {
  /** This host holds no handed key. */
  wanted(): Promise<boolean>
  /** Refused unless it is this store's key. */
  offer(key: Buffer): Promise<void>
}

export interface HostSecrets {
  secrets: Secrets
  handover: SecretKeyHandover
}

export function dataKeyPath(userRoot: string): string {
  return join(userRoot, "secrets", "data-key")
}

/**
 * Where a host keeps its data key when no keychain and no desktop can give it one (`fileKey`): `MAKO_SECRET_KEY_FILE`,
 * else `<userRoot>/secrets/host-key` on a machine that isn't a Mac. None on a Mac, whose keychain or desktop gives the
 * key, nor on a cloud machine, whose agent delivers its secrets.
 */
export function secretKeyFile(userRoot: string, { env, cloudMachine }: { env: NodeJS.ProcessEnv; cloudMachine: boolean }): string | undefined {
  if (env.MAKO_SECRET_KEY_FILE) return resolve(env.MAKO_SECRET_KEY_FILE)
  return onMac() || cloudMachine ? undefined : join(userRoot, "secrets", "host-key")
}

/**
 * The secrets of every host this user runs: the installed app and
 * `npm run dev` read one Cursor key, and a host isolated in a temporary root
 * keeps its own. The data key is wrapped by the keychain item older builds
 * used through `safeStorage`, so moving onto this store asks for nothing new.
 *
 * The desktop hands the key over, since its `safeStorage` reads the item
 * without asking the person. The host reads the item itself only without
 * one, as Mako Helper, after giving a desktop that started it a moment to
 * hand the key over. Either way each older file is taken over the first time
 * its record is read, opened by the same keychain.
 */
export function openHostSecrets({ userRoot, keychain, legacy, handoverUntil = 0, keyFile }: HostSecretsInput): HostSecrets {
  const path = dataKeyPath(userRoot)
  const wrapped = wrappedKey(path, keychain)
  const handed = handedKey(path)
  const own = keyFile === undefined ? undefined : fileKey(keyFile)
  const key: SecretKey = own
    ? {
        available: async () => true,
        key: async (create) => ((await keychain.available()) ? wrapped.key(create) : own.key(create)),
      }
    : {
        available: async () => handed.held() || (await keychain.available()),
        async key(create) {
          if (!handed.held() && (await keychain.available())) await handed.arrival(handoverUntil - Date.now())
          if (handed.held() || !(await keychain.available())) return handed.key(create)
          return wrapped.key(create)
        },
      }
  return {
    secrets: new GrantedSecrets(adoptingLegacy(fileSecrets(join(userRoot, "secrets"), aesSealer(key)), {
      encryption: keychain,
      ...legacyFiles(legacy),
    }), join(userRoot, "borrowing")),
    handover: {
      wanted: async () => !handed.held(),
      offer: (value) => handed.offer(value),
    },
  }
}

/** What a domain keeps its secrets through. */
export interface DomainSecrets {
  readonly secrets: Secrets
  /** Where the domain's older builds kept its secrets; declared as it's built, before it reads them. */
  adoptLegacy(files: LegacyFiles): void
}

/** A host's secrets: every domain's, and the desktop's handover of the key that opens them. */
export interface HostSecretStore extends DomainSecrets {
  readonly handover: SecretKeyHandover
  /** The broker the saved records stand as grants of (`GrantedSecrets`), seeded with every record saved before grants were kept. */
  borrowing(): Promise<LocalBorrowing | undefined>
  /** A saved record's version as its grant's leases name it (`GrantedSecrets.version`), never its value. */
  secretVersion(kind: SecretKind, name: string): Promise<string | undefined>
}

/**
 * This host's one store. It opens on its first read, not here: harnesses take
 * it as they are installed, before every domain has declared its older files.
 */
export function hostSecretStore({ userRoot, appName }: Pick<HostEnvironment, "userRoot" | "appName">, { keyFile }: { keyFile?: string | undefined } = {}): HostSecretStore {
  const legacy: LegacyFiles[] = []
  let opened: HostSecrets | undefined
  const host = () => (opened ??= openHostSecrets({
    userRoot,
    keychain: chromiumSafeStorage({ appName, keychain: processKeychain(() => heavy.keyring.load("keychain")) }),
    legacy,
    handoverUntil: performance.timeOrigin + HANDOVER_GRACE_MS,
    ...(keyFile !== undefined && { keyFile }),
  }))
  return {
    secrets: {
      durable: () => host().secrets.durable(),
      read: (kind, name) => host().secrets.read(kind, name),
      write: (kind, name, value, options) => host().secrets.write(kind, name, value, options),
      delete: (kind, name) => host().secrets.delete(kind, name),
      list: (kind) => host().secrets.list(kind),
    },
    handover: {
      wanted: () => host().handover.wanted(),
      offer: (key) => host().handover.offer(key),
    },
    borrowing: async () => {
      const { secrets } = host()
      if (!(secrets instanceof GrantedSecrets)) return undefined
      await secrets.seed()
      return secrets.broker
    },
    secretVersion: async (kind, name) => {
      const { secrets } = host()
      return secrets instanceof GrantedSecrets ? secrets.version(kind, name) : undefined
    },
    adoptLegacy: (files) => {
      legacy.push(files)
    },
  }
}

/** Secrets held in memory and lost with the process, for a fixture desk or a detached host. */
export function detachedSecrets(): DomainSecrets {
  return { secrets: memorySecrets({ durable: false }), adoptLegacy: () => {} }
}
