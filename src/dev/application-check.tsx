import { createRoot } from "react-dom/client"
import { ApplicationReview } from "./application-review"
import { application, applicationStore } from "@/state/application"
import { updatesStore } from "@/state/updates"
import { bindTheme, prefsStore } from "@/state/prefs"
import { getMako } from "@/lib/bridge"
import { installMockBridge } from "./mock-bridge"
import { threadMoveStepped } from "@/state/cloud-moves"
import type { LifecycleState, LifecycleWork, LocalBuildState, UpdateInstallation } from "@mako/host/contracts/app-lifecycle"
import type { HandOffCandidate, HandOffResult, ThreadMoveStep } from "@mako/host/contracts/cloud-threads"
import "../index.css"

installMockBridge()
const bridge = getMako()
const identity = {
  id: "7ae32bc6849e318f",
  builtAt: "2026-09-10T12:30:00.000Z",
  revision: "a".repeat(40),
  dirty: true,
}
let installation: UpdateInstallation = {
  distribution: "local",
  build: identity,
  source: "/Users/developer/Projects/mako",
  local: { kind: "idle" },
}
const WORK: LifecycleWork[] = [
    {
      id: "one",
      token: "one",
      title: "Refine the update experience",
      provider: "devin",
      cwd: "/Projects/mako",
      status: "running",
      stoppable: true,
    },
    {
      id: "two",
      token: "two",
      title: "Review the deployment changes",
      provider: "claude",
      cwd: "/Projects/backend",
      status: "waiting",
      stoppable: true,
    },
    {
      id: "three",
      token: "three",
      title: "Add regression coverage",
      provider: "codex",
      cwd: "/Projects/mako",
      status: "queued",
      stoppable: true,
    },
]
let lifecycle: LifecycleState = {
  revision: "review-one",
  operation: { kind: "idle" },
  work: WORK,
}
export const calls = {
  build: 0,
  quit: 0,
  stopped: 0,
  waited: 0,
  checked: 0,
  acknowledged: 0,
  handedOff: 0,
}

/**
 * Handing agents to the cloud at quit. `all`: every Thread at work can go, and each does; `mixed`: one can't (it works
 * in the project folder), and one that tries stays because the cloud is full.
 */
type HandOffScene = { candidates: HandOffCandidate[]; fails: string[] }
let handOff: HandOffScene = { candidates: [], fails: [] }
export function handOffScene(kind: "all" | "mixed" | "none") {
  const refused = "It works in the project folder. Move it to its own branch first."
  handOff = {
    candidates: kind === "none" ? [] : WORK.map((item, index) => ({ conversationId: item.id, thread: `thread-${item.id}`, harness: item.provider, title: item.title, ...kind === "mixed" && index === 2 && { refusal: refused } })),
    fails: kind === "mixed" ? ["two"] : [],
  }
  lifecycle = { ...lifecycle, work: WORK, operation: { kind: "idle" } }
  applicationStore.set({ lifecycle, busy: false, dialog: null, error: null })
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export function setLocal(local: LocalBuildState) {
  installation = { ...installation, local }
  applicationStore.set({ installation })
}
export function ready() {
  setLocal({ kind: "ready", build: { ...identity, id: "8fc69a47318e520b" } })
}
export function idle() {
  lifecycle = { ...lifecycle, work: [], operation: { kind: "idle" } }
  applicationStore.set({ lifecycle, busy: false, dialog: null })
}
export function fail(message: string) {
  setLocal({ kind: "error", message })
}
export function theme(theme: "light" | "dark") {
  prefsStore.set({ theme })
}
export function published() {
  installation = {
    ...installation,
    distribution: "signed",
    local: { kind: "idle" },
  }
  applicationStore.set({ installation })
  updatesStore.set({ status: "idle" })
}
window.mako = {
  ...bridge,
  lifecycleState: async () => lifecycle,
  installationState: async () => installation,
  selectUpdateSource: async (source) => {
    installation = { ...installation, source }
    return installation
  },
  pickFolder: async () => "/Users/developer/Projects/mako",
  buildUpdate: async () => {
    calls.build++
    setLocal({ kind: "building", phase: "compiling" })
  },
  quitClient: async () => {
    calls.quit++
  },
  handOffCandidates: async () => handOff.candidates,
  handOff: async (id: string): Promise<HandOffResult[]> => {
    calls.handedOff++
    const going = handOff.candidates.filter((candidate) => !candidate.refusal)
    const steps: ThreadMoveStep[] = [{ kind: "packing" }, { kind: "pausing" }, { kind: "handing-over" }, { kind: "resuming" }]
    const results = await Promise.all(going.map(async (candidate, index): Promise<HandOffResult> => {
      const move = `${id}:${candidate.thread}`
      await pause(index * 120)
      const failing = handOff.fails.includes(candidate.conversationId)
      for (const step of failing ? steps.slice(0, 1) : steps) {
        threadMoveStepped(candidate.conversationId, move, step)
        await pause(700)
      }
      if (failing) {
        const reason = "Its cloud machine didn't get ready: Mako Cloud is full right now: every machine it can run is busy. Try again once one finishes."
        threadMoveStepped(candidate.conversationId, move, { kind: "kept-here", reason })
        return { conversationId: candidate.conversationId, outcome: { kind: "kept-here", reason } }
      }
      // As the host answers a quit's handoff: once this Mac let go, the rest carried by the host.
      threadMoveStepped(candidate.conversationId, move, { kind: "handing-over" })
      return { conversationId: candidate.conversationId, outcome: { kind: "released", cloudThread: `t-${candidate.thread}` } }
    }))
    const moved = new Set(results.filter((result) => result.outcome.kind === "released").map((result) => result.conversationId))
    lifecycle = { ...lifecycle, work: lifecycle.work.filter((item) => !moved.has(item.id)) }
    return results
  },
  acknowledgeShutdown: async () => {
    calls.acknowledged++
  },
  checkUpdates: async () => {
    calls.checked++
    return { status: "current", version: "0.0.1" }
  },
  lifecycleCommand: async (command) => {
    if (command.kind === "cancel")
      lifecycle = { ...lifecycle, operation: { kind: "idle" } }
    else if (command.kind === "wait") {
      calls.waited++
      lifecycle = {
        ...lifecycle,
        operation: { kind: "waiting", action: command.action },
      }
    } else {
      calls.stopped++
      lifecycle = { ...lifecycle, operation: { kind: "idle" }, work: [] }
    }
    applicationStore.set({ lifecycle })
    return lifecycle
  },
}
prefsStore.set({ theme: "dark" })
bindTheme()
updatesStore.set({ version: "0.0.1", status: "unsupported" })
await application.load()
const root = document.getElementById("root")
if (root) createRoot(root).render(<ApplicationReview />)
