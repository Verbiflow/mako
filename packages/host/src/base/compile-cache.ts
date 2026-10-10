import { enableCompileCache, constants as moduleConstants } from "node:module"
import { join } from "node:path"

/**
 * V8 bytecode for the host's own modules, kept between starts. The main
 * process is ~170 ES modules that Node compiles from source on every launch;
 * with the cache it deserializes them instead. The directory sits under the
 * data root, so a fixture's temporary root never touches the user's cache,
 * and Node keys entries by source hash and V8 version, so a new build simply
 * misses once. `MAKO_COMPILE_CACHE=0` turns it off for a measurement.
 *
 * Called from `entry.ts` before anything else loads; `main.ts` reports the
 * outcome in its first log line.
 */
let status = "not requested"

export function enableMainCompileCache(dataRoot: string): string {
  if (process.env.MAKO_COMPILE_CACHE === "0") {
    status = "disabled"
    return status
  }
  const result = enableCompileCache(join(dataRoot, "compile-cache"))
  switch (result.status) {
    case moduleConstants.compileCacheStatus.ENABLED:
      status = "enabled"
      break
    case moduleConstants.compileCacheStatus.ALREADY_ENABLED:
      status = "already enabled"
      break
    case moduleConstants.compileCacheStatus.DISABLED:
      status = "disabled"
      break
    default:
      status = `failed: ${result.message ?? "unknown"}`
  }
  return status
}

export function compileCacheStatus(): string {
  return status
}
