import type { CloudTurnOn, TurnOnStep, TurnOnStepId, TurnOnStepOf } from "@mako/host/contracts/cloud-turn-on"
import { getMako, hasBridge } from "@/lib/bridge"
import { actions } from "@/state/session"
import { offerCloudProjects } from "@/state/cloud-projects"
import { prepareCloudNow } from "@/state/prewarm"
import { runPlaceStore } from "@/state/run-place"
import { createHook, createStore } from "@/state/store"

/**
 * Turning Mako Cloud on, as the host follows it (`mako:cloud-turn-on`, then its `cloud-turn-on` events): this store
 * only mirrors it, so Settings and the rail say the same, in every window. The host reads each step from what owns
 * it, so nothing here counts on its own.
 */
type Busy = "check" | "retry"

interface CloudTurnOnState {
  turnOn?: CloudTurnOn
  busy?: Busy
  failure?: { action: Busy | "start"; message: string }
}

export const cloudTurnOnStore = createStore<CloudTurnOnState>({})
export const useCloudTurnOn = createHook(cloudTurnOnStore)

let loading: Promise<void> | undefined

async function run(busy: Busy, work: () => Promise<CloudTurnOn>): Promise<void> {
  if (cloudTurnOnStore.get().busy) return
  cloudTurnOnStore.set({ busy, failure: undefined })
  try {
    cloudTurnOnStore.set({ turnOn: await work() })
  } catch (error) {
    cloudTurnOnStore.set({ failure: { action: busy, message: error instanceof Error ? error.message : String(error) } })
  } finally {
    cloudTurnOnStore.set({ busy: undefined })
  }
}

export const cloudTurnOn = {
  /** Read once; the host's events keep it current from then on. */
  load() {
    if (!hasBridge() || cloudTurnOnStore.get().turnOn) return
    loading ??= getMako()
      .cloudTurnOn()
      .then((turnOn) => cloudTurnOnStore.set({ turnOn }))
      .catch(() => undefined)
      .finally(() => (loading = undefined))
    // A Mac signed in before this window opened offers its projects here, as a sign-in's event would have.
    void getMako().cloudAccount().then(offerCloudProjects, () => undefined)
  },

  heard(turnOn: CloudTurnOn) {
    cloudTurnOnStore.set({ turnOn })
  },

  /** Asks the cloud now whether the account has it, rather than at the next connection token. */
  checkPlan: () => run("check", () => getMako().cloudTurnOnCheck()),

  retryBases: () => run("retry", () => getMako().cloudTurnOnRetryBases()),

  /**
   * The first Thread in the cloud: a new Thread in the project, with Cloud chosen, its machine made ahead at once
   * rather than after the first words, since starting it is the whole intent. The person writes; it's warm by then.
   */
  async startThread(folder: string) {
    runPlaceStore.set({ cloud: true })
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    if (!(await actions.newConversationIn(folder))) {
      cloudTurnOnStore.set({ failure: { action: "start", message: `A new Thread couldn't open in ${folder}.` } })
      return
    }
    prepareCloudNow(folder)
  },

  /** A pointer resting on Start: the machine is made ahead while the person decides. */
  warm(folder: string) {
    prepareCloudNow(folder)
  },
}

export function stepOf<Id extends TurnOnStepId>(turnOn: CloudTurnOn | undefined, id: Id): TurnOnStepOf<Id> | undefined {
  return turnOn?.steps.find((step): step is TurnOnStepOf<Id> => step.id === id)
}

/** Steps still going by themselves, and the ones that need the person or are stuck. */
export type OpenSteps = { working: TurnOnStep[]; yours: TurnOnStep[]; stuck: TurnOnStep[] }

export function openSteps(turnOn: CloudTurnOn): OpenSteps {
  return {
    working: turnOn.steps.filter((step) => step.state === "working"),
    yours: turnOn.steps.filter((step) => step.state === "yours"),
    stuck: turnOn.steps.filter((step) => step.state === "stuck"),
  }
}
