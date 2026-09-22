import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join, basename } from "node:path"
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
  try {
    const path = join(directory, "Preferences")
    if ((await stat(path)).size > 8 * 1024 * 1024) return
    return preferences.parse(JSON.parse(await readFile(path, "utf8"))).profile
      .name
  } catch {
    return
  }
}
