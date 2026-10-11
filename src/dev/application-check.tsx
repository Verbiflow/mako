import { createRoot } from "react-dom/client"
import { ApplicationReview } from "./application-review"
import { application, applicationStore } from "@/state/application"
import { updatesStore } from "@/state/updates"
import { bindTheme, prefsStore } from "@/state/prefs"
import { getMako } from "@/lib/bridge"
import { installMockBridge } from "./mock-bridge"
import type { LifecycleState, LocalBuildState, UpdateInstallation } from "@mako/host/contracts/app-lifecycle"
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
let lifecycle: LifecycleState = {
  revision: "review-one",
  operation: { kind: "idle" },
  work: [
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
  ],
}
export const calls = {
  build: 0,
  quit: 0,
  stopped: 0,
  waited: 0,
  checked: 0,
  acknowledged: 0,
}
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
