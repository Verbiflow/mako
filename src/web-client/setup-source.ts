import { SETUP_PATHS, type SetupActOutcome, type SetupView } from "@mako/host/contracts/setup"
import type { SetupSource } from "@/state/setup"
import type { Gateway } from "./gateway"

/** A project's Setup from a browser away from the Mac: the account's broker answers, as a Mac's host does. */
export function webSetup(gateway: Gateway, account: string): SetupSource {
  return {
    read: async (project) => {
      const answer = await gateway.rest("GET", SETUP_PATHS.view(account, project))
      // SAFETY: the broker answers the contract's own `SetupView`, the same object a device's host derives.
      return answer as SetupView
    },
    act: async (project, act) => {
      const answer = await gateway.rest("POST", SETUP_PATHS.act(account, project), act)
      // SAFETY: the broker answers the contract's own `SetupActOutcome`, as a device's host does.
      return answer as SetupActOutcome
    },
  }
}
