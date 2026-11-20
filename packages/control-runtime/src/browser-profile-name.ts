import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join, basename, dirname } from "node:path"
import { z } from "zod"

const displayName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) =>
    Array.from(value).every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  )
const preferences = z.object({ profile: z.object({ name: displayName }) })
const localStateProfiles = z.object({ profile: z.object({ info_cache: z.record(z.string(), z.json()) }) })
const profileInfo = z.object({ name: displayName })

/** A unique profile is identifiable; multiple profiles must never use last-used. */
export async function singleBrowserProfile(
  root: string
): Promise<string | undefined> {
  if (!isAbsolute(root)) return
  try {
    const path = join(root, "Local State")
    if ((await stat(path)).size > 8 * 1024 * 1024) return
    const state = z
      .object({
        profile: z.object({ info_cache: z.record(z.string(), z.unknown()) }),
      })
      .parse(JSON.parse(await readFile(path, "utf8")))
    const profiles = Object.keys(state.profile.info_cache)
    if (profiles.length !== 1) return
    const profile = profiles[0]!
    if (
      !profile ||
      profile === "." ||
      profile === ".." ||
      basename(profile) !== profile ||
      profile.includes("\\")
    )
      return
    return join(root, profile)
  } catch {
    return
  }
}

export async function browserProfileName(
  directory: string
): Promise<string | undefined> {
  if (!isAbsolute(directory)) return
  try {
    const path = join(dirname(directory), "Local State")
    if ((await stat(path)).size <= 8 * 1024 * 1024) {
      const state = z.object({ profile: z.object({ info_cache: z.record(z.string(), z.json()) }) })
        .parse(JSON.parse(await readFile(path, "utf8")))
      const profile = z.object({ name: displayName }).safeParse(state.profile.info_cache[basename(directory)])
      if (profile.success) return profile.data.name
    }
  } catch {
    // Older roots can lack the index. The exact profile Preferences is the fallback.
  }
  try {
    const path = join(directory, "Preferences")
    if ((await stat(path)).size > 8 * 1024 * 1024) return
    return preferences.parse(JSON.parse(await readFile(path, "utf8"))).profile
      .name
  } catch {
    return
  }
}

/** A user-data folder's profiles, as its `Local State` lists them: each one's folder, and its name where it has one. */
export async function browserProfiles(
  root: string
): Promise<{ directory: string; name?: string }[]> {
  try {
    const path = join(root, "Local State")
    if ((await stat(path)).size > 8 * 1024 * 1024) return []
    const state = localStateProfiles.parse(JSON.parse(await readFile(path, "utf8")))
    return Object.entries(state.profile.info_cache)
      .filter(([folder]) => folder && folder !== "." && folder !== ".." && basename(folder) === folder && !folder.includes("\\"))
      .slice(0, 64)
      .map(([folder, info]) => {
        const name = profileInfo.safeParse(info)
        return { directory: join(root, folder), ...(name.success && { name: name.data.name }) }
      })
  } catch {
    return []
  }
}
