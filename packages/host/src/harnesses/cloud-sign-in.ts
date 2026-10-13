import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, sep } from "node:path"
import type { CloudSignIn } from "../contracts/cloud-sign-ins.js"
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
  /** Writes `payload` where the harness reads it, replacing what an earlier install wrote. */
  install(payload: CloudSignInPayload, place: CloudSignInPlace): Promise<void>
}

/** The refresh token's place in a payload: kept empty, so a harness that insists on the field still parses. */
export const WITHHELD = ""

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
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, JsonValue>
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
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
    const exp = claims && typeof claims === "object" && "exp" in claims ? claims.exp : undefined
    return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : null
  } catch {
    return null
  }
}

/** A millisecond or ISO instant as ISO, or null when it isn't one. */
export function instant(value: JsonValue | undefined): string | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

export function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

/** The record without the fields that must not leave this Mac. */
export function without(record: Record<string, JsonValue>, ...fields: string[]): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)))
}
