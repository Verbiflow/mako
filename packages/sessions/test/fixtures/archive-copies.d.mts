import type { Thread } from "../../src/format.ts"

/** Copies as builds before the archive's migration kept them, one row per session. */
export function keepCopies(root: string, threads: readonly Thread[]): Promise<void>
/** A copy as the oldest builds kept one, as a folder; its path. */
export function keepLegacyCopy(root: string, thread: Thread): Promise<string>
