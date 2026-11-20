import type { ProjectAppSetup } from "@mako/host/contracts/project-app"
import { recipeChangeContext } from "@/lib/app-setup-context"
import { actions } from "@/state/session"

/**
 * A new Thread in the project with its recipe attached; the person says what to change, or sends `request`, written
 * for them. A recipe changes only this way: an agent makes the change and Mako proves it before every Thread gets it.
 * Settings closes first.
 */
export async function changeWithAgent(setup: ProjectAppSetup, request = ""): Promise<void> {
  const context = recipeChangeContext(setup)
  if (!context) return
  window.dispatchEvent(new CustomEvent("mako:close-settings"))
  if (!(await actions.newConversationIn(setup.root))) return
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("mako:attach", {
      detail: {
        files: [{ file: new File([context.text], context.name, { type: "text/markdown" }), contextLabel: context.label }],
        text: () => request,
      },
    }))
  )
}
