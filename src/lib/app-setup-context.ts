import type { ThreadAppView } from "../../electron/contracts/thread-app"
import { ENVIRONMENT_SETUP_PROMPT } from "../../electron/contracts/thread-environments"

/** Menu action, replaced by an ordinary portable attachment when picked. */
export const APP_SETUP_CONTEXT = "mako:app-setup"

/** The composer's row for the project's app, by what its recipe needs: set up, fixed, or changed. */
export function appSetupRow(view: ThreadAppView | undefined): { title: string; hint: string } | null {
  if (view?.kind === "none") return { title: "Set up the app", hint: `${view.project} · not set up` }
  if (view?.kind === "invalid") return { title: "Fix the app's recipe", hint: `${view.project} · broken` }
  if (view?.kind === "ready") return { title: "Change how the app runs", hint: `${view.project} · recipe` }
  return null
}

/**
 * What the row attaches: the request for that state and what Mako knows of
 * the recipe, with the tools that act on it. The person's own words in the
 * message come first.
 */
export function appSetupContext(view: ThreadAppView | undefined): { name: string; label: string; text: string } | null {
  if (!view || view.kind === "setting-up") return null
  const project = view.project
  const body =
    view.kind === "none"
      ? `${project} has no recipe yet, so its Threads can't run their own copy of the app.\n\nUnless the message asks for something else: ${ENVIRONMENT_SETUP_PROMPT} Start with the mako server's recipe_guide; it says how, and how to prove it works.`
      : view.kind === "invalid"
        ? `${project}'s recipe is broken: ${view.message}\n\nUnless the message asks for something else, fix it so every Thread can run and check its own copy again. app_status shows the recipe, recipe_guide explains every field, and recipe_save replaces it; prove the fix with app_restart and app_check.`
        : `${project} has a recipe. ${recipeSummary(view)}\n\nThe message says what to change about how ${project} installs, starts or is checked. app_status shows the whole recipe and recipe_save replaces it; prove the change with app_restart and app_check.`
  return {
    name: `${project}-app.md`,
    label: `App · ${project}`,
    text: `# ${project}'s app\n\nAttached by the user in Mako: a snapshot of the app's state when attached.\n\n${body}\n`,
  }
}

function recipeSummary(view: Extract<ThreadAppView, { kind: "ready" }>): string {
  const processes = view.processes.map((entry) => (entry.port ? `${entry.name} on port ${entry.port}` : entry.name))
  const checks = view.checks.map((check) => `${check.tier} check \`${check.command}\``)
  return [
    processes.length ? `Its processes: ${processes.join(", ")}.` : "It starts no processes.",
    checks.length ? `Its checks: ${checks.join(", ")}.` : "It has no checks.",
  ].join(" ")
}
