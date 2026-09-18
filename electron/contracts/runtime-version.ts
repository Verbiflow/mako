/**
 * Version strings the way CLIs print them, compared the way a person would.
 *
 * No imports: the host reads installed and public versions with this, and the
 * renderer decides whether a row says "current" or "update available" with
 * the same function, so the two never disagree about `0.154.0-alpha.6.2`
 * against `0.154.0`.
 */

/** The first version-shaped token in a CLI's output; `undefined` when none. */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+(?:\.\d+)+(?:[-.][\w.-]*)?/)?.[0]
}

/**
 * Semver-style ordering with room for what real CLIs print: Cursor's
 * `2026.09.10-fd3934a` dates, Codex's `0.154.0-alpha.6.2` prereleases.
 * A prerelease sorts before its release; two prereleases compare identifier
 * by identifier, numerically when both sides are numbers.
 */
export function compareVersions(left: string, right: string): number {
  const [leftCore, leftPre] = split(left)
  const [rightCore, rightPre] = split(right)
  const length = Math.max(leftCore.length, rightCore.length)
  for (let index = 0; index < length; index++) {
    const difference = (leftCore[index] ?? 0) - (rightCore[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const count = Math.max(leftPre.length, rightPre.length)
  for (let index = 0; index < count; index++) {
    const a = leftPre[index]
    const b = rightPre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)
    const difference = numeric ? Number(a) - Number(b) : a.localeCompare(b)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function split(version: string): [number[], string[]] {
  const trimmed = version.trim().replace(/^v/i, "")
  const dash = trimmed.indexOf("-")
  const core = dash === -1 ? trimmed : trimmed.slice(0, dash)
  const pre = dash === -1 ? "" : trimmed.slice(dash + 1)
  return [
    core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre ? pre.split(/[.-]/) : [],
  ]
}

/** Whether a public version is newer than the installed one; `null` when either is unknown. */
export function versionBehind(
  installed: string | undefined,
  latest: string | undefined
): boolean | null {
  if (!installed || !latest) return null
  return compareVersions(installed, latest) < 0
}
