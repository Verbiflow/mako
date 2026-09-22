let scope: string | undefined

/** Stable host identity for browser storage, independent of a host restart. */
export function setClientStorageScope(value: string): void {
  if (scope !== undefined && scope !== value)
    throw new Error("This web server switched Mako hosts. Reload to connect to the new host; pending messages remain saved for the original host.")
  scope = value
}

export function clientStorageScope(): string {
  return scope ?? new URLSearchParams(globalThis.location?.search).get("profile") ?? ""
}
