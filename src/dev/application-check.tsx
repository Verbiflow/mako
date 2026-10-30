import { createRoot } from "react-dom/client"
import { ApplicationReview } from "./application-review"
import { application, applicationStore } from "@/state/application"
import { updatesStore } from "@/state/updates"
import { bindTheme, prefsStore } from "@/state/prefs"
import { getMako } from "@/lib/bridge"
import { installMockBridge } from "./mock-bridge"
import { threadMoveStepped } from "@/state/cloud-moves"
import type { LifecycleState, LifecycleWork, LocalBuildState, RevisionChanges, UncommittedChanges, UpdateInstallation, UpdateSource } from "@mako/host/contracts/app-lifecycle"
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
  checkout: null,
  reading: false,
  installed: null,
}

/** The installed revision and origin/main 21 merged pull requests later, as on the day the updater built what was already installed. */
const INSTALLED = "9a7a5c0c4c9be872bbbbab91721f326d461fa830"
const UPSTREAM = "079f9b315af4593fec599bf9926fad1797dbec64"
const LOCAL = "4be1d02a7e93c5f18a0d6b2c97e4f3a1d8c0b5e6"
const CHANGES: RevisionChanges = {
  from: INSTALLED,
  count: 21,
  titles: [
    "Proofs and tests run harnesses in a home of their own: nothing they start reaches the person's sidebar (#189)",
    "Sync the last 30 days whole, the newest first, from one truth per Session (#188)",
    "A turn's work reads as one calm column: running calls sweep their own row, agents are named while they run and wear their harness's mark, and \"working\" is an ellipsis (#187)",
    "Allowing a tool draws nothing over the composer: no empty bar for an answer handed over at once (#186)",
    "Cursor: finish a turn the SDK's resumes fail after it ended; contain closed exec-stream writes (#185)",
    "Archiving a cloud Thread ends it in the cloud, for every device; restoring brings it back to its Mac (#182)",
    "The rail says when a quiet device was last seen: \"seen 3h\" on its Thread's row, and \"last seen 3 hours ago\" in its tip (#184)",
    "A quiet device is said once, not on each of its rows: nothing it lists shows at work or waiting while the account can't hear it (#183)",
  ],
}
const installedBuild = { id: "b9c5c96a71e04f0d", builtAt: "2026-10-28T08:22:00.000Z", revision: INSTALLED, dirty: false }
const CLEAN: UncommittedChanges = { count: 0, files: [] }
/** A shared checkout mid-afternoon: other agents' edits, a rename, a new file not added yet. */
const UNCOMMITTED: UncommittedChanges = {
  count: 41,
  files: [
    { path: "packages/host/src/conversations/live-runtime.ts", change: "edited" },
    { path: "packages/host/src/base/heap-watch.ts", change: "untracked" },
    { path: "packages/sessions/src/reading-copies.ts", change: "edited" },
    { path: "scripts/test-heap-watch.ts", change: "untracked" },
    { path: "src/components/settings/sync-status.tsx", change: "renamed", from: "src/components/settings/sync-section.tsx" },
    { path: "scripts/bench-session-uploads.ts", change: "deleted" },
  ],
}
const reading = (overrides: Partial<Extract<UpdateSource, { kind: "checkout" }>>): UpdateSource => ({
  kind: "checkout",
  head: INSTALLED,
  branch: "main",
  upstream: { name: "origin/main", commit: UPSTREAM, branch: "main" },
  ahead: 0,
  behind: 21,
  changed: 0,
  untracked: 0,
  uncommitted: CLEAN,
  fetch: { kind: "fetched" },
  plan: { kind: "fast-forward" },
  target: UPSTREAM,
  changes: CHANGES,
  readAt: "2026-10-28T08:20:00.000Z",
  ...overrides,
})
const LEVEL = reading({ head: UPSTREAM, behind: 0, plan: { kind: "as-is", why: "level", installed: false } })
const BY_HAND = "cd '/Users/developer/Projects/mako' && npm install"
/**
 * The source checkout's states, as Settings › Updates draws them: behind and clean, already installed, kept from the
 * update by local changes, on another branch, offline, installing what the new package-lock.json lists (or refusing
 * to, or failing to), mid-build, ready, and the build that installed it.
 */
export const SOURCE_SCENES = {
  behind: { checkout: reading({}) },
  current: { checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "current" }, changes: { from: UPSTREAM, count: 0, titles: [] } }), build: { ...installedBuild, id: "c41e7d2f9a0b3e65", revision: UPSTREAM } },
  changes: { checkout: reading({ changed: 3, untracked: 1, uncommitted: { count: 4, files: UNCOMMITTED.files.slice(0, 4) }, plan: { kind: "as-is", why: "changes", installed: false }, target: INSTALLED, changes: { from: INSTALLED, count: 0, titles: [] } }) },
  uncommitted: { checkout: reading({ head: UPSTREAM, behind: 0, changed: 39, untracked: 2, uncommitted: UNCOMMITTED, plan: { kind: "as-is", why: "level", installed: false } }), build: { ...installedBuild, revision: INSTALLED, dirty: true, uncommitted: { count: 12, files: UNCOMMITTED.files.slice(0, 3) } } },
  branch: { checkout: reading({ head: LOCAL, branch: "approval-bar", ahead: 2, plan: { kind: "as-is", why: "branch", installed: false }, target: LOCAL, changes: { from: INSTALLED, count: 2, titles: ["Approve in place (#190)", "Name the waiting tool"] } }) },
  diverged: { checkout: reading({ head: LOCAL, ahead: 2, plan: { kind: "as-is", why: "diverged", installed: false }, target: LOCAL, changes: { from: INSTALLED, count: 2, titles: ["Local experiment", "Local fix"] } }) },
  offline: { checkout: reading({ fetch: { kind: "failed", reason: "origin didn't answer in 15 seconds" }, behind: 4, upstream: { name: "origin/main", commit: "d9da1b16a8e2f3c4b5a6978877665544332211ff", branch: "main" }, target: "d9da1b16a8e2f3c4b5a6978877665544332211ff", changes: { ...CHANGES, count: 4, titles: CHANGES.titles.slice(4) } }) },
  installing: { checkout: LEVEL, local: { kind: "building", phase: "installing", revision: UPSTREAM, dependencies: { count: 1, names: ["@mako/web-client"] } } },
  installRefused: { checkout: reading({ head: UPSTREAM, behind: 0, changed: 1, uncommitted: { count: 1, files: [{ path: "package-lock.json", change: "edited" }] }, plan: { kind: "as-is", why: "level", installed: false } }), local: { kind: "error", message: `The update couldn't install dependencies: package-lock.json lists a package the checkout hasn't installed: @mako/web-client. The checkout has uncommitted changes to package-lock.json, so Mako won't run npm install there for you. Commit or discard them, or run npm install yourself, then build again. Your installed app and agents were not changed.`, command: BY_HAND } },
  installFailed: { checkout: LEVEL, local: { kind: "error", message: `The update couldn't install dependencies: npm install didn't finish within 10 minutes, so Mako stopped it. Run npm install yourself to see the whole error, then build again. Your installed app and agents were not changed.`, command: BY_HAND } },
  building: { checkout: LEVEL, local: { kind: "building", phase: "checking", revision: UPSTREAM } },
  ready: { checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "as-is", why: "level", installed: false } }), local: { kind: "ready", build: { ...installedBuild, id: "c41e7d2f9a0b3e65", builtAt: "2026-10-28T09:05:00.000Z", revision: UPSTREAM }, changes: CHANGES, forwarded: { branch: "main", from: INSTALLED, to: UPSTREAM } } },
  installed: { checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "current" }, changes: { from: UPSTREAM, count: 0, titles: [] } }), build: { ...installedBuild, id: "c41e7d2f9a0b3e65", builtAt: "2026-10-28T09:05:00.000Z", revision: UPSTREAM }, installed: CHANGES },
} satisfies Record<string, Partial<UpdateInstallation>>
export function sourceScene(name: keyof typeof SOURCE_SCENES) {
  lifecycle = { ...lifecycle, work: [], operation: { kind: "idle" } }
  installation = { ...installation, build: installedBuild, local: { kind: "idle" }, reading: false, installed: null, ...SOURCE_SCENES[name] }
  applicationStore.set({ installation, lifecycle, busy: false, dialog: null, error: null })
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
  sourceChecks: 0,
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
  setLocal({ kind: "ready", build: { ...identity, id: "8fc69a47318e520b" }, changes: null, forwarded: null })
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
  checkUpdateSource: async () => {
    calls.sourceChecks++
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
