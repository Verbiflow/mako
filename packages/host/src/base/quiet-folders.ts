/** Folders whose churn is never a change anyone watching a project means: dependencies and build output. */
export const QUIET_FOLDERS = ["node_modules", ".next", "dist", "dist-electron", "build", "out", "target", "coverage", ".turbo", "release", ".venv"] as const
