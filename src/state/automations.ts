import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import type { AutomationProjectReading, AutomationRun, AutomationView } from "@/lib/types"

/**
 * Every served project's automations (`contracts/automations.ts`), as the host reads them: definitions from each
 * project's file, and what this Mac keeps of them. Whether one is on is a local decision, held in the host and never
 * written to the shared file: cloning a repository must not start running an agent.
 */
export const automationsStore = createStore<{ projects: AutomationProjectReading[]; list: AutomationView[]; recent: AutomationRun[] }>({
  projects: [],
  list: [],
  recent: [],
})

export const useAutomations = createHook(automationsStore)

function applyProjects(projects: AutomationProjectReading[]) {
  automationsStore.set({ projects, list: projects.flatMap((project) => project.automations) })
}

/** One project's reading replaced: `automations-changed`. */
export function applyAutomationsReading(reading: AutomationProjectReading) {
  const others = automationsStore.get().projects.filter((project) => project.project !== reading.project)
  applyProjects([...others, reading].sort((a, b) => a.project.localeCompare(b.project)))
}

export function noteAutomationRun(run: AutomationRun) {
  const recent = automationsStore.get().recent.filter((entry) => !(entry.project === run.project && entry.automation === run.automation && entry.occurrence === run.occurrence))
  automationsStore.set({ recent: [run, ...recent].slice(0, 20) })
}

export const automations = {
  async load() {
    if (!hasBridge()) return
    const reading = await getMako().automations().catch(() => null)
    if (reading) applyProjects(reading.projects)
  },

  async setEnabled(project: string, id: string, enabled: boolean) {
    const reading = await getMako().setAutomationEnabled(project, id, enabled).catch(() => null)
    if (reading) applyAutomationsReading(reading)
  },

  run(project: string, id: string) {
    void getMako().runAutomation(project, id, crypto.randomUUID())
  },

  async decide(proposal: string, approve: boolean) {
    await getMako().decideAutomationProposal(proposal, approve).catch(() => null)
  },
}
