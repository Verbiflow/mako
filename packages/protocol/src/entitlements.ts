/**
 * What an account may use, as its connection tokens list it (`entitlements`). A gateway grants them; a device reads
 * them to decide what it offers, and the gateway holds to the same rule.
 */

/** Threads on Mako's cloud machines, and everything those need. */
export const CLOUD_ENTITLEMENT = "cloud"

/**
 * The account's own devices reach one another: each serves its host as a runtime (`d-<device>`), so the others watch
 * its Sessions and start work there. A gateway that doesn't grant it yet admits a device's runtime with `cloud` alone.
 */
export const DEVICES_ENTITLEMENT = "devices"

/** Whether a device of this account serves its host to the account as a runtime. */
export function servesDeviceRuntime(entitlements: readonly string[]): boolean {
  return entitlements.includes(DEVICES_ENTITLEMENT) || entitlements.includes(CLOUD_ENTITLEMENT)
}
