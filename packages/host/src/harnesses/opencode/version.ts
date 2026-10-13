import { compareVersions } from "../../contracts/runtime-version.js"
import { OPENCODE_VERSIONS } from "./versions.js"

/** The oldest OpenCode whose server Mako's client speaks, as `versions.ts` declares and proves it. */
export const OPENCODE_OLDEST: string = OPENCODE_VERSIONS.oldest
/**
 * Prereleases count builds, not versions: the first dev build with the API
 * 2.0.4 released. The builds before it changed that API a route at a time,
 * which neither Mako's client nor `legacy-api.ts` speaks as a whole.
 */
const OLDEST_BUILD = 19656
/** The first release with the API Mako's client speaks; the releases before it get `legacy-api.ts`. */
const CURRENT_API = "2.0.4"

const VERSION = /^(?:opencode2?\s+)?v?(?:2\.(\d+)\.(\d+)(?:[-+][\w.-]+)?|0\.0\.0-(beta|dev)-(\d+))$/i

/** Whether a reported OpenCode 2 is at least this release or, for a prerelease, this build. */
function atLeast(reported: string, release: string, build: number): boolean | undefined {
  const match = VERSION.exec(reported.trim())
  if (!match) return undefined
  const [, minor, patch, channel, number] = match
  return channel ? Number(number) >= build : compareVersions(`2.${minor}.${patch}`, release) >= 0
}

/** OpenCode 2 under any version it has used: a 2.x release or a beta or dev build. */
export function isOpenCodeV2(version: string): boolean {
  return VERSION.test(version.trim())
}

/** The version alone, as `/api/info` gives it, from what `opencode --version` prints (`opencode v2.0.1`). */
export function openCodeVersionNumber(reported: string): string {
  return reported.trim().replace(/^(?:opencode2?\s+)?v?/i, "")
}

/** Why Mako cannot run this OpenCode, or nothing when it can. Releases newer than Mako's own client are run too. */
export function openCodeVersionProblem(version: string): string | undefined {
  const reported = version.trim()
  const current = atLeast(reported, OPENCODE_OLDEST, OLDEST_BUILD)
  if (current === undefined) return `Mako runs OpenCode ${OPENCODE_OLDEST} or newer; this executable reports "${reported}". Install the current OpenCode release.`
  if (current) return undefined
  return `OpenCode ${openCodeVersionNumber(reported)} is older than Mako supports. Update OpenCode to ${OPENCODE_OLDEST} or newer.`
}

/** Whether this OpenCode serves the API from before 2.0.4, which Mako speaks through `legacy-api.ts`. */
export function openCodeServesLegacyApi(version: string): boolean {
  return atLeast(version, CURRENT_API, OLDEST_BUILD) === false
}
