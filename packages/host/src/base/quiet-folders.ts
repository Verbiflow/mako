/** Folders whose churn is never a change anyone watching a project means: dependencies and build output. */
export const QUIET_FOLDERS = ["node_modules", ".next", "dist", "dist-electron", "build", "out", "target", "coverage", ".turbo", "release", ".venv"] as const

const QUIET = new Set<string>(QUIET_FOLDERS)
/** A copy kept beside a folder: `dist-old`, `build.bak`, `dist_2`, `node_modules copy`, `dist (2)`. */
const COPY = /^(.+?)(?:[-_.](?:old|bak|backup|copy|orig|prev|previous|tmp|\d+)| copy(?: \d+)?| \(\d+\))$/i

/** Whether a folder named `name` is one of `QUIET_FOLDERS`, or a copy of one. */
export function quietFolder(name: string): boolean {
  if (QUIET.has(name)) return true
  const original = COPY.exec(name)?.[1]
  return original !== undefined && quietFolder(original)
}
