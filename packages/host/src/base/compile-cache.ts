import { enableCompileCache, getCompileCacheDir, constants as moduleConstants } from "node:module"
import { join } from "node:path"

/**
 * V8 bytecode for the host's own modules, kept between starts. The main
 * process is ~170 ES modules that Node compiles from source on every launch;
 * with the cache it deserializes them instead. The directory sits under the
 * data root, so a fixture's temporary root never touches the user's cache,
 * and Node keys entries by source hash and V8 version, so a new build simply
 * misses once. `MAKO_COMPILE_CACHE=0` turns it off for a measurement.
 *
 * Called from `entry.ts` before anything else loads, which says when it
 * failed; `host-main.ts` reports where the cache is in its first log line.
 */
export function enableMainCompileCache(dataRoot: string): string {
  if (process.env.MAKO_COMPILE_CACHE === "0") return "disabled"
  const result = enableCompileCache(join(dataRoot, "compile-cache"))
  switch (result.status) {
    case moduleConstants.compileCacheStatus.ENABLED:
      return "enabled"
    case moduleConstants.compileCacheStatus.ALREADY_ENABLED:
      return "already enabled"
    case moduleConstants.compileCacheStatus.DISABLED:
      return "disabled"
    default:
      return `failed: ${result.message ?? "unknown"}`
  }
}

/** Where this process's modules are cached, as Node has it. */
export function compileCacheStatus(): string {
  const directory = getCompileCacheDir()
  return directory ? `enabled at ${directory}` : "off"
}
