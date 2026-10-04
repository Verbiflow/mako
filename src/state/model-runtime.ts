import { getMako } from "@/lib/bridge"
import type {
  UtilityCatalogInput,
  UtilityConnectionInput,
  UtilityProvider,
  UtilityTask,
} from "@/lib/types"

export const utilityModels = {
  settings: () => getMako().utilityModelSettings(),
  async catalog(input: UtilityCatalogInput) {
    try {
      return await getMako().utilityModelCatalog(input)
    } catch (error) {
      if (
        error instanceof Error &&
        /No handler registered|Unknown Mako host method|utilityModelCatalog.*not a function/.test(
          error.message
        )
      )
        throw new Error(
          "Restart Mako to load model discovery after active agents finish. Reload UI does not update the host.",
          { cause: error }
        )
      throw error
    }
  },
  connect: (input: UtilityConnectionInput) =>
    getMako().connectUtilityModel(input),
  disconnect: (provider: UtilityProvider) =>
    getMako().disconnectUtilityModel(provider),
  /** What does a small task: `auto`, `off` for titles, or a model `settings()` lists. */
  choose: (task: UtilityTask, choice: string) => getMako().chooseUtilityModel(task, choice),
}
