import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

const run = promisify(execFile)
const TIMEOUT_MS = 2_000
const SALT = "mako-telemetry-machine\0"

/**
 * This computer as telemetry names it: a salted SHA-256 of the system's own
 * hardware or install ID, cut to 32 hex characters. Every install and profile
 * on one computer shares it, so they count as one; the salt keeps it from
 * matching the raw ID or any other app's hash of it. Undefined when the
 * system won't say.
 */
export async function telemetryMachineId(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const raw = await systemMachineId(platform).catch(() => undefined)
  return raw ? hashMachineId(raw) : undefined
}

export function hashMachineId(raw: string): string {
  return createHash("sha256").update(SALT).update(raw.trim().toLowerCase()).digest("hex").slice(0, 32)
}

async function systemMachineId(platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform === "darwin") {
    const { stdout } = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: TIMEOUT_MS })
    return /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(stdout)?.[1]
  }
  if (platform === "linux") {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const id = (await readFile(file, "utf8").catch(() => "")).trim()
      if (/^[0-9a-f]{32}$/.test(id)) return id
    }
    return undefined
  }
  if (platform === "win32") {
    const { stdout } = await run("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { timeout: TIMEOUT_MS })
    return /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(stdout)?.[1]
  }
  return undefined
}
