import { unwatchedWork, type HostWork } from "../base/event-loop.js"
import type { AdmittedLiveDriver, ProviderLiveDriver } from "./live-driver.js"
import { validateLiveDriver } from "./live-driver.js"
import { withNativeExclusion } from "./native-exclusion.js"
import { withExecutionAdmission, type AccountAdmission } from "./execution-admission.js"
import { ProviderRegistry } from "./registry.js"

/** Every harness's live driver, each validated as it registers and handed out behind native exclusion and admission. */
export class LiveDrivers {
  private readonly drivers = new ProviderRegistry<AdmittedLiveDriver>()
  private readonly admission: AccountAdmission
  private readonly work: HostWork

  constructor(admission: AccountAdmission, work: HostWork = unwatchedWork) {
    this.admission = admission
    this.work = work
  }

  register(driver: ProviderLiveDriver): () => void {
    validateLiveDriver(driver)
    return this.drivers.register(withExecutionAdmission(withNativeExclusion(driver), this.admission, this.work))
  }

  get(provider: string): AdmittedLiveDriver | undefined {
    return this.drivers.get(provider)
  }

  list(): AdmittedLiveDriver[] {
    return this.drivers.list()
  }
}
