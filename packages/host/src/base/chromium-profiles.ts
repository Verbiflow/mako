import { lstat, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

/**
 * Chromium-family browsers on this machine, found by what they keep rather
 * than by product name: every user-data root holds a `Local State` naming
 * its profiles. The browser extension's setup registers its helper in each;
 * the attachments' sweep reads each profile's localStorage for drafts of a
 * desk opened in that browser.
 */

const chromiumLocalStateSchema = z
  .object({
    browser: z
      .object({
        first_run_finished: z.literal(true),
      })
      .loose(),
    profile: z
      .object({
        info_cache: z.record(z.string(), z.json()),
      })
      .loose(),
  })
  .loose()

async function childDirectories(
  directory: string,
  limit: number
): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .sort()
      .slice(0, limit)
  } catch {
    return []
  }
}

async function isChromiumProfileRoot(directory: string): Promise<boolean> {
  try {
    const path = join(directory, "Local State")
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) return false
    const state = chromiumLocalStateSchema.parse(
      JSON.parse(await readFile(path, "utf8"))
    )
    return Object.keys(state.profile.info_cache).length > 0
  } catch {
    return false
  }
}

/**
 * Chromium products keep `Local State` at their user-data root. Discovering
 * that capability supports branded forks without a product-name allowlist.
 */
export async function chromiumProfileRoots(base: string): Promise<string[]> {
  const firstLevel = await childDirectories(base, 512)
  const nested = await Promise.all(
    firstLevel.map(async (directory) => ({
      directory,
      children: await childDirectories(directory, 32),
    }))
  )
  const candidates = [
    ...firstLevel,
    ...nested.flatMap(({ children }) => children).slice(0, 2048),
  ]
  const checks = await Promise.all(
    candidates.map(async (directory) => ({
      directory,
      matches: await isChromiumProfileRoot(directory),
    }))
  )
  return checks
    .filter(({ matches }) => matches)
    .map(({ directory }) => directory)
    .sort()
}
