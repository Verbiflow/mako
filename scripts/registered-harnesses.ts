import { providerHost } from "../electron/providers/index.ts"

/** Generic shared-policy coverage follows the installed capability registry. */
export function registeredHarnessIds(): string[] {
  return providerHost.harnesses.list().map(({ provider }) => provider)
}
