import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"

const providerHost = createHarnessHost(detachedHarnessContext())

/** Generic shared-policy coverage follows the installed capability registry. */
export function registeredHarnessIds(): string[] {
  return providerHost.harnesses.list().map(({ provider }) => provider)
}
