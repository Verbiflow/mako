import { useEffect, useMemo } from "react"
import { useCloudAccount } from "@/state/cloud-account"
import { useGitHub } from "@/state/github"
import { openProjectPalette } from "@/state/open-project"
import { prefsStore, setSetupChecklist, usePrefs } from "@/state/prefs"
import { useProjectRoots } from "@/state/project-settings"
import { openProjectSetup } from "@/state/project-setup"
import { useProviderConnections } from "@/state/provider-connections"
import { createStore } from "@/state/store"
import { useThreadApp } from "@/state/thread-app"

/**
 * Finish setting up: what's left of a new desk, read from real facts, each step opening the place that does it. It
 * sits above the rail's footer until every step is done, when it leaves for good, or until the person puts it away,
 * when it's in the palette and the account menu.
 */
export type SetupStepId = "agent" | "project" | "github" | "setup" | "phone"

export interface SetupStep {
  id: SetupStepId
  label: string
  done: boolean
  run: () => void
}

const settings = (section: string) => () => window.dispatchEvent(new CustomEvent("mako:settings", { detail: section }))

/** A phone or tablet the account was used from: a browser session on iOS, iPadOS or Android. */
export function phoneLinked(browsers: ReadonlyArray<{ os: string | null }> | undefined): boolean {
  return Boolean(browsers?.some((browser) => /\b(?:ios|ipados|iphone|ipad|android)\b/i.test(browser.os ?? "")))
}

export function useSetupSteps(): SetupStep[] {
  const agent = useProviderConnections((state) => state.connections.some((connection) => connection.state.status === "signed-in"))
  const roots = useProjectRoots()
  const github = useGitHub((state) => Boolean(state.status?.authenticated))
  // A project is set up once its app's recipe is ready: Mako knows how to set it up and run it.
  const setUp = useThreadApp((state) => Object.values(state.byCwd).some((view) => view?.kind === "ready" || view?.kind === "asleep"))
  const phone = useCloudAccount((state) => phoneLinked(state.browsers))
  const project = roots.length > 0
  return useMemo(
    () => [
      { id: "agent", label: "Sign in to an agent", done: agent, run: settings("agents") },
      { id: "project", label: "Open a project", done: project, run: () => openProjectPalette() },
      { id: "github", label: "Connect GitHub", done: github, run: settings("git") },
      { id: "setup", label: "Set up this project", done: setUp, run: openProjectSetup },
      { id: "phone", label: "Get Mako on your phone", done: phone, run: settings("devices") },
    ],
    [agent, project, github, setUp, phone]
  )
}

/** How many steps are left, as the rail last read them: the palette's Finish setting up shows while any is. */
export const setupLeftStore = createStore<{ left: number }>({ left: 0 })

/** Whether the checklist is still to finish: some step isn't done. Put away or not. */
export function useSetupLeft(): number {
  return useSetupSteps().filter((step) => !step.done).length
}

/** Keeps `setupLeftStore` current; mounted with the rail. */
export function useFollowSetupLeft(): number {
  const left = useSetupLeft()
  useEffect(() => setupLeftStore.set({ left }), [left])
  return left
}

/** Where it shows: above the footer, unless put away or done. */
export function useChecklistShown(): boolean {
  const putAway = usePrefs((prefs) => prefs.setupChecklist.putAway)
  const left = useFollowSetupLeft()
  return !putAway && left > 0
}

/** Brings it back above the footer, open: the palette's and the account menu's Finish setting up. */
export function showSetupChecklist(): void {
  setSetupChecklist({ putAway: false, open: true })
}

export function putSetupChecklistAway(): void {
  setSetupChecklist({ putAway: true })
}

export function toggleSetupChecklist(): void {
  setSetupChecklist({ open: !prefsStore.get().setupChecklist.open })
}
