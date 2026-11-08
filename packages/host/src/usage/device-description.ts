import { hostCommand } from "../base/host-command.js"
import { hostname } from "node:os"
import { devicePlatform, onMac } from "../base/platform.js"

/** How a device names itself on its account's device list. */
export type DeviceDescription = { name: string; platform: string; appVersion: string }

/**
 * This device as its account lists it: the name `name` gives, else on a Mac the one people gave it in System
 * Settings, else its hostname; its system (`devicePlatform`); and this build's version.
 */
export async function describeThisDevice(appVersion: string, name?: string): Promise<DeviceDescription> {
  const platform = devicePlatform()
  if (name?.trim()) return { name: name.trim(), platform, appVersion }
  const fallback = hostname().replace(/\.local$/, "")
  const named = onMac()
    ? await hostCommand("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }).then(
        ({ stdout }) => stdout.trim() || fallback,
        () => fallback
      )
    : fallback
  return { name: named, platform, appVersion }
}
