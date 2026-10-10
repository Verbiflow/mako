import { PROTOCOL_VERSION, type DaemonStats } from "@mako/sessions"

/**
 * Whether the daemon answering the socket is one this build should keep using.
 *
 * Prefer the reader-code/root/archive identity over installation paths. Equal
 * copies can share one catalog; changed code or roots must remain isolated.
 * Callers without a scope retain the legacy script check. Scoped callers
 * require an exact identity; missing evidence does not establish compatibility.
 */
export function daemonIsForeign(
  stats: Pick<DaemonStats, "version" | "script" | "catalogIdentity">,
  script: string,
  catalogIdentity?: string
): boolean {
  if (stats.version !== PROTOCOL_VERSION) return true
  if (catalogIdentity)
    return stats.catalogIdentity !== catalogIdentity
  return stats.script !== undefined && stats.script !== script
}
