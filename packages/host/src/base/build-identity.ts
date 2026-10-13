import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { BuildIdentitySchema } from "../contracts/app-lifecycle.js"
import type { HostEnvironment } from "./host-environment.js"

/**
 * What a packaged build knows about itself. `package-mac.mjs` stamps the
 * bundle's package.json with `makoBuild`; a checkout has no stamp.
 */
export const BuildMetadataSchema = z.object({
  makoBuild: BuildIdentitySchema.optional(),
  /** The Mako cloud `MAKO_CLOUD_URL` named when the bundle was packaged. */
  makoCloud: z.url({ protocol: /^https$/ }).optional().catch(undefined),
  makoLocalSigningIdentity: z
    .string()
    .regex(/^[a-fA-F0-9]{40}$/)
    .optional(),
})
export type BuildMetadata = z.infer<typeof BuildMetadataSchema>

/** What the app at `appRoot` was stamped with, for a process that needs no more of its environment. */
export function buildMetadataAt(appRoot: string): BuildMetadata {
  return BuildMetadataSchema.parse(JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")))
}

/** `MAKO_CLOUD_URL`, else the cloud the bundle was packaged with; a checkout has none of its own. */
export function cloudUrl(environment: Pick<HostEnvironment, "build">, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MAKO_CLOUD_URL || environment.build.makoCloud
}

/**
 * The string that must change whenever a daemon spawned by this process should
 * be replaced by the next host to start. Local builds all report version 0.0.1,
 * so the version alone would keep an old bundle's daemon alive across every
 * update; the build ID separates them. A checkout has no build ID and answers
 * with its app path, so a checkout's daemon never masquerades as a bundle's.
 */
export function buildTag({ build, version, appRoot }: Pick<HostEnvironment, "build" | "version" | "appRoot">): string {
  return `${version}+${build.makoBuild?.id ?? appRoot}`
}

/** The build a runtime enrols with, for the gateway's logs: the version, and the build ID's first twelve characters when there is one. */
export function runtimeBuild({ build, version }: Pick<HostEnvironment, "build" | "version">): string {
  return build.makoBuild ? `${version}+${build.makoBuild.id.slice(0, 12)}` : version
}
