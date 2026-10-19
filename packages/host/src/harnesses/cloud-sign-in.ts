import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, sep } from "node:path"
import { z } from "zod"
import type { CloudSignIn, CloudSignInChain } from "../contracts/cloud-sign-ins.js"
import type { JsonValue } from "../contracts/json.js"

/** A harness's sign-in as its adapter reads it for the cloud: everything but which harness it is. */
export type CloudSignInExport = Omit<CloudSignIn, "harness">
export type CloudSignInPayload = CloudSignIn["payload"]

/** Where a machine's adapter writes a sign-in. */
export interface CloudSignInPlace {
  /** The machine user's home, where each harness looks. */
  home: string
  /** A folder in memory that only the host can read; secret files are kept here and linked from `home`. */
  secrets: string
}

/**
 * The sign-in half of an account capability: `export` on the Mac, `install`
 * on a cloud machine, so one adapter owns its harness's store both ways.
 */
export interface CloudSignInCapability {
  /**
   * The sign-in the store `env` points at, refresh token withheld, or null
   * when it's signed out. Reads without prompting and without a network call.
   */
  export(env: NodeJS.ProcessEnv): Promise<CloudSignInExport | null>
  /**
   * The whole sign-in the store `env` points at, refresh token included, for Mako Cloud to refresh for this Mac (see
   * `mirror`), or null when it's signed out. Only a harness whose sign-in rotates has one.
   */
  chain?(env: NodeJS.ProcessEnv): Promise<CloudSignInChain | null>
  /** This Mac's own store read whole and written back, for a sign-in that rotates and that Mako Cloud refreshes for it. */
  mirror?: CloudSignInMirror
  /** Writes `payload` where the harness reads it, replacing what an earlier install wrote. */
  install(payload: CloudSignInPayload, place: CloudSignInPlace): Promise<void>
  /** Takes back what `install` wrote, signing the harness out; true when there was something to take. */
  remove(place: CloudSignInPlace): Promise<boolean>
}

/**
 * A rotating sign-in shared with Mako Cloud, which refreshes it for both: each refresh is written back here, before
 * the harness would refresh by itself. Every harness re-reads its store before it refreshes and runs on a newer pair
 * it finds there, as it does for another of its own processes, so it never presents a token the cloud moved past.
 */
export interface CloudSignInMirror {
  /** The refresh token in a `chain` payload of this harness's shape; null for none (cleared, signed out, a key). */
  token(payload: CloudSignInPayload): string | null
  /** Who the payload signs in as, by the provider's account id; null when it doesn't say. */
  principal(payload: CloudSignInPayload): string | null
  /**
   * Writes `chain` where the harness reads it under `env`, only if the refresh token there still has fingerprint
   * `expected` (null: none). False when the store moved on meanwhile, or the harness is mid-refresh; the next check
   * reads it again.
   */
  write(env: NodeJS.ProcessEnv, chain: CloudSignInChain, expected: string | null): Promise<boolean>
}

/** A refresh token by the first 8 characters of its SHA-256, as Mako Cloud names it: compared and logged, never the value. */
export function chainFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("base64url").slice(0, 8)
}

/**
 * Runs `work` holding the lock a harness takes with proper-lockfile: a folder made atomically at `path`, stale once
 * unchanged for `staleMs`, as that package judges it. Undefined when it stays held for `waitMs`: the harness is in
 * the middle of its own write, and the caller tries again later.
 */
export async function withFolderLock<T>(path: string, staleMs: number, work: () => Promise<T>, waitMs = 2_000): Promise<T | undefined> {
  const until = Date.now() + waitMs
  for (;;) {
    try {
      await mkdir(path)
      break
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      const held = await stat(path).catch(() => null)
      if (held && Date.now() - held.mtimeMs > staleMs) {
        await rm(path, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= until) return undefined
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await work()
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

/** Replaces `path` with `text` in one rename, so a harness reading it sees the old file or the new, never half. */
export async function replaceFile(path: string, text: string): Promise<void> {
  await writeAtomic(path, text, 0o600)
}

/** The refresh token's place in a payload: kept empty, so a harness that insists on the field still parses. */
export const WITHHELD = ""

/** A JSON object as a harness wrote it, every field kept. */
export const JsonObjectSchema = z.record(z.string(), z.json())

const JwtExpirySchema = z.object({ exp: z.number() })
const InstantSchema = z.union([z.number(), z.string().transform((text) => Date.parse(text))])

function inside(root: string, relative: string): string {
  const clean = normalize(relative)
  if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`)) throw new Error(`${relative} isn't inside the home folder`)
  return join(root, clean)
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, path)
}

/**
 * A secret file: kept in `place.secrets`, and linked from where the harness
 * reads it in `place.home`. A file or older link already there is replaced.
 */
export async function placeSecret(place: CloudSignInPlace, relative: string, text: string): Promise<void> {
  const kept = inside(place.secrets, relative)
  const read = inside(place.home, relative)
  await writeAtomic(kept, text, 0o600)
  await mkdir(dirname(read), { recursive: true, mode: 0o700 })
  if ((await readlink(read).catch(() => null)) === kept) return
  await rm(read, { force: true })
  await symlink(kept, read)
}

/** Takes back what `placeSecret` placed: the file in memory and the link to it. True when there was one. */
export async function removeSecret(place: CloudSignInPlace, relative: string): Promise<boolean> {
  const kept = inside(place.secrets, relative)
  const read = inside(place.home, relative)
  if ((await readlink(read).catch(() => null)) === kept) await rm(read, { force: true })
  const had = (await lstat(kept).catch(() => null)) !== null
  await rm(kept, { force: true })
  return had
}

/**
 * A harness's own settings file in `place.home`, not a secret: `change` gets
 * what's there (null when there's none, or it isn't a JSON object) and
 * returns what to write. The harness keeps writing to it as it runs.
 */
export async function changeJsonFile(
  place: CloudSignInPlace,
  relative: string,
  change: (current: Record<string, JsonValue> | null) => Record<string, JsonValue>,
): Promise<void> {
  const path = inside(place.home, relative)
  let current: Record<string, JsonValue> | null = null
  if ((await lstat(path).catch(() => null))?.isFile()) {
    try {
      const parsed = JsonObjectSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
      if (parsed.success) current = parsed.data
    } catch {
      // Unreadable settings are replaced rather than kept half-understood.
    }
  }
  await writeAtomic(path, `${JSON.stringify(change(current), null, 2)}\n`, 0o600)
}

/** The ISO time of a JWT's `exp`, or null when it has none. */
export function jwtExpiry(token: string | undefined): string | null {
  if (!token) return null
  try {
    const claims = JwtExpirySchema.safeParse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")))
    return claims.success ? new Date(claims.data.exp * 1000).toISOString() : null
  } catch {
    return null
  }
}

/** A millisecond or ISO instant as ISO, or null when it isn't one. */
export function instant(value: JsonValue | undefined): string | null {
  const ms = InstantSchema.safeParse(value)
  return ms.success && Number.isFinite(ms.data) && ms.data > 0 ? new Date(ms.data).toISOString() : null
}

export function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | null {
  const parsed = JsonObjectSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The record without the fields that must not leave this Mac. */
export function without(record: Record<string, JsonValue>, ...fields: string[]): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)))
}
