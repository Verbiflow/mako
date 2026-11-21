import { setupStep, type SetupConsent, type SimulatorSetup } from "../../contracts/simulator-setup.js"
import type { SimulatorAgent, SimulatorAvailability, SimulatorConsent } from "../../contracts/simulators.js"

// Whether simulators are offered here and to whom, read from the setup line alone: an agent's `mako` server decides
// its simulator tools by these as it's built (`mcp.ts`), with nothing else of the simulators loaded.

/** Whether this Mac can run an iPhone simulator, and if not the first thing missing, from the setup line. */
export function iosAvailability(setup: SimulatorSetup, canDrive = true): SimulatorAvailability {
  if (setup.phase === "unavailable") return { ready: false, blocker: "not-macos", why: "iPhone and iPad simulators run on macOS alone." }
  if (setupStep(setup, "xcode")?.state !== "done") return { ready: false, blocker: "no-xcode", why: "This Mac has no Xcode, so no iOS Simulator.", fix: "Settings › Simulators" }
  if (setupStep(setup, "finish")?.state !== "done") return { ready: false, blocker: "no-xcode", why: "Xcode's first-run setup isn't finished.", fix: "Settings › Simulators" }
  if (setupStep(setup, "runtime")?.state !== "done") return { ready: false, blocker: "no-runtime", why: "Xcode has no iOS simulator runtime yet.", fix: "Settings › Simulators" }
  if (setupStep(setup, "tools")?.state !== "done") return { ready: false, blocker: "no-tools", why: "Mako's simulator tools aren't installed yet.", fix: "Settings › Simulators" }
  if (!canDrive) return { ready: false, blocker: "not-built", why: "This copy of Mako can list simulators but has no way to drive them." }
  return { ready: true }
}

/** The person's answer for where an agent works: the nearest folder they answered for, then its worktree's project. */
export function consentFor(consent: readonly SetupConsent[], agent: Pick<SimulatorAgent, "folder" | "project">): SimulatorConsent {
  const answerFor = (folder: string) =>
    consent.filter((entry) => folder === entry.folder || folder.startsWith(`${entry.folder}/`)).sort((left, right) => right.folder.length - left.folder.length)[0]
  const answer = answerFor(agent.folder) ?? (agent.project ? answerFor(agent.project) : undefined)
  return answer ? (answer.allowed ? "allowed" : "refused") : "unasked"
}
