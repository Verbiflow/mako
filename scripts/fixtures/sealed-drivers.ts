import { detachedHarnessContext, harnessModules } from "@mako/host/harnesses/harness-host"
import { createProviderHost, type ProviderModule } from "@mako/host/harnesses/host"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { LiveDrivers } from "@mako/host/harnesses/live-drivers"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

/**
 * Each harness's driver as it registers, not as the host hands it out: behind
 * admission, a start runs on the account admission resolves, which in a
 * detached host is the person's own login, whatever environment it was given.
 * A sealed driver runs on the `accountLaunch` its start passes, and nothing else.
 */
class SealedDrivers extends LiveDrivers {
  readonly raw = new Map<string, ProviderLiveDriver>()
  override register(driver: ProviderLiveDriver): () => void {
    this.raw.set(driver.provider, driver)
    return super.register(driver)
  }
}

/** The live drivers `installs` register, every harness Mako ships unless named, each sealed, by harness. */
export function sealedDrivers(installs: readonly ProviderModule[] = harnessModules): ReadonlyMap<string, ProviderLiveDriver> {
  const context = detachedHarnessContext(new NativeStores(false))
  const sealed = new SealedDrivers({
    resolve: () => Promise.reject(new Error("A sealed driver starts only on the launch it is given")),
    assertCurrent: async () => {},
    principal: async () => undefined,
    mismatch: (principal) => new Error(principal),
    observeUsage: () => {},
  })
  const host = { ...createProviderHost(context), liveDrivers: sealed }
  for (const install of installs) install(host, context)
  return sealed.raw
}
