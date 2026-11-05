import { SETUP_PATHS, SetupActOutcomeSchema, SetupViewSchema } from "@mako/host/contracts/setup"
import type { SetupSource } from "@/state/setup"
import type { Gateway } from "./gateway"

/** A project's Setup from a browser away from the Mac: the account's broker answers, as a Mac's host does. */
export function webSetup(gateway: Gateway, account: string): SetupSource {
  return {
    read: async (project) => {
      return SetupViewSchema.parse(await gateway.rest("GET", SETUP_PATHS.view(account, project)))
    },
    act: async (project, act) => {
      return SetupActOutcomeSchema.parse(await gateway.rest("POST", SETUP_PATHS.act(account, project), act))
    },
  }
}
