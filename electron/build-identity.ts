import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { z } from "zod"
import { BuildIdentitySchema, type BuildIdentity } from "./contracts/app-lifecycle.js"

/**
 * What a packaged build knows about itself. `package-mac.mjs` stamps the
 * bundle's package.json with `makoBuild`; a checkout has no stamp.
 */
const metadataSchema = z.object({
  makoBuild: BuildIdentitySchema.optional(),
  /** The Mako cloud `MAKO_CLOUD_URL` named when the bundle was packaged. */
  makoCloud: z.url({ protocol: /^https$/ }).optional().catch(undefined),
  makoLocalSigningIdentity: z
    .string()
    .regex(/^[a-fA-F0-9]{40}$/)
    .optional(),
})
export type BuildMetadata = z.infer<typeof metadataSchema>

let cached: BuildMetadata | undefined

export function buildMetadata(): BuildMetadata {
  cached ??= metadataSchema.parse(
    JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"))
  )
  return cached
}

export function buildIdentity(): BuildIdentity | null {
  return buildMetadata().makoBuild ?? null
}

/** `MAKO_CLOUD_URL`, else the cloud the bundle was packaged with; a checkout has none of its own. */
export function cloudUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MAKO_CLOUD_URL || buildMetadata().makoCloud
}

/**
 * The string that must change whenever a daemon spawned by this process should
 * be replaced by the next host to start. Local builds all report version 0.0.1,
 * so the version alone would keep an old bundle's daemon alive across every
 * update; the build ID separates them. A checkout has no build ID and answers
 * with its app path, so a checkout's daemon never masquerades as a bundle's.
 */
export function buildTag(): string {
  const build = buildIdentity()
  const source = build ? build.id : app.getAppPath()
  return `${app.getVersion()}+${source}`
}
