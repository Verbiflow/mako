/** Removes a test's scratch folder; on Windows what Node's removal refuses (read-only files) goes by the system's `rd`. */
export function removeScratch(path: string): void
