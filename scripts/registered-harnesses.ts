import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

/** Generic shared-policy coverage follows the installed capability registry. */
export function registeredHarnessIds(): string[] {
  return providerHost.harnesses.list().map(({ provider }) => provider)
}
