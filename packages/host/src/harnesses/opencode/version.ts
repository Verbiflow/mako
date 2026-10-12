/**
 * The oldest OpenCode whose server Mako's client speaks. 2.0.6 brought
 * `/api/info` and the API every later release has only added to.
 */
export const OPENCODE_OLDEST = "2.0.6"
/** Prereleases count builds, not versions: the first dev build after 2.0.6. */
const OLDEST_BUILD = 19740

const VERSION = /^(?:opencode2?\s+)?v?(?:2\.(\d+)\.(\d+)(?:[-+][\w.-]+)?|0\.0\.0-(beta|dev)-(\d+))$/i

/** OpenCode 2 under any version it has used: a 2.x release or a beta or dev build. */
export function isOpenCodeV2(version: string): boolean {
  return VERSION.test(version.trim())
}

/** Why Mako cannot run this OpenCode, or nothing when it can. Releases newer than Mako's own client are run too. */
export function openCodeVersionProblem(version: string): string | undefined {
  const reported = version.trim()
  const match = VERSION.exec(reported)
  if (!match) return `Mako runs OpenCode ${OPENCODE_OLDEST} or newer; this executable reports "${reported}". Install the current OpenCode release.`
  const [, minor, patch, channel, build] = match
  const current = channel ? Number(build) >= OLDEST_BUILD : Number(minor) > 0 || Number(patch) >= 6
  if (current) return undefined
  return `OpenCode ${reported.replace(/^(?:opencode2?\s+)?v?/i, "")} is older than Mako supports. Update OpenCode to ${OPENCODE_OLDEST} or newer.`
}
