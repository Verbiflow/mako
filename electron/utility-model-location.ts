import { randomUUID } from "node:crypto"
import { mkdir, readdir, rename, rm, rmdir, stat, utimes, writeFile, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { utilityProviderSchema } from "./utility-models.js"

/**
 * Model connections are per user, not per host profile. The keychain key that
 * `safeStorage` wraps them with is already shared by every Mako binary on the
 * machine, so keeping the ciphertext under each profile's data root only meant
 * connecting Gemini once in the installed app, again in `npm run dev`, and
 * again in every review profile. They live beside the other per-user state in
 * `~/.mako`.
 *
 * A fixture host keeps them inside its own root so a test never reads,
 * writes, or disconnects the user's real connections. What marks a fixture is
 * where its root is, not how it was started: the desktop launcher hands every
 * host — the installed app's, `npm run dev`'s, each profile's — its directory
 * as `MAKO_DATA_ROOT`, so the variable alone means nothing (the relay gate in
 * `main.ts` reads it the same way). A profile lives under the platform's
 * application-data directory; a temporary root anywhere else is isolated.
 * When this keyed on the variable no real host ever reached the user store
 * and the one-time move was a no-op from a directory onto itself.
 */
export function utilityModelDirectory(input: {
  dataRoot: string
  /** `app.getPath("appData")`: where profile roots live. */
  appData: string
  home?: string
}): string {
  const root = resolve(input.dataRoot)
  const appData = resolve(input.appData)
  const isProfile = root === appData || root.startsWith(appData + sep)
  if (!isProfile) return join(root, "utility-models")
  return join(input.home ?? homedir(), ".mako", "utility-models")
}

/** The directory a profile host used before connections became per user. */
export function legacyUtilityModelDirectory(dataRoot: string): string {
  return join(dataRoot, "utility-models")
}

export interface UtilityModelMigration {
  /** Provider files the shared store did not have yet. */
  moved: string[]
  /** Provider files that replaced an older shared copy. */
  replaced: string[]
  /** Provider files dropped because the shared copy was at least as new. */
  dropped: string[]
}

/**
 * One-time move of a profile's connection files into the shared store. The
 * newest copy of each provider wins whichever host migrates first: a file
 * keeps its modification time across the move, so a later host with a newer
 * copy replaces it and a host with an older copy drops its own. Only files
 * named for a known provider are touched; anything else stays where it is.
 * Two hosts migrating at once both land on the same result because every
 * write is a rename and a source that has already gone is not an error.
 */
export async function migrateUtilityModels(
  from: string,
  to: string
): Promise<UtilityModelMigration> {
  const result: UtilityModelMigration = { moved: [], replaced: [], dropped: [] }
  if (resolve(from) === resolve(to)) return result
  const entries = await readdir(from).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (!entries) return result
  for (const entry of entries) {
    if (!entry.endsWith(".enc")) continue
    const provider = utilityProviderSchema.safeParse(basename(entry, ".enc"))
    if (!provider.success) continue
    const source = join(from, entry)
    const target = join(to, entry)
    const sourceInfo = await statOrNull(source)
    if (!sourceInfo?.isFile() || sourceInfo.size > 32_768) continue
    const targetInfo = await statOrNull(target)
    if (targetInfo && targetInfo.mtimeMs >= sourceInfo.mtimeMs) {
      await rm(source, { force: true })
      result.dropped.push(provider.data)
      continue
    }
    await mkdir(to, { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, await readFile(source), { mode: 0o600, flag: "wx" })
      await utimes(temporary, sourceInfo.atime, sourceInfo.mtime)
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
    await rm(source, { force: true })
    ;(targetInfo ? result.replaced : result.moved).push(provider.data)
  }
  await rmdir(from).catch(() => undefined)
  return result
}

function statOrNull(path: string) {
  return stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
}
