import { codexExecutableCandidates } from "./executable.js"
import { codexAccessModes, CODEX_DEFAULT_MODE } from "./access.js"
import type { ProviderLiveDriver } from "../live-driver.js"

export const codexLiveDriver: ProviderLiveDriver = {
  provider: "codex",
  observesNativeAgents: true,
  canResume: true,
  forkPoint: "run",
  steer: async (...args) =>
    (await import("../../codex-app.js")).codexAppSteer(...args),
  // Re-probed 2026-09-14 (app-server 0.147.0): after thread/compact/start a
  // resumed thread keeps the original turns' items and gains a
  // contextCompaction record — the earlier drop is fixed.
  compact: async (id) =>
    (await import("../../codex-app.js")).codexAppCompact(id),
  available: () => codexExecutableCandidates().length > 0,
  start: async (...args) =>
    (await import("../../codex-app.js")).codexAppStart(...args),
  prompt: async (...args) =>
    (await import("../../codex-app.js")).codexAppPrompt(...args),
  permission: async (...args) => {
    ;(await import("../../codex-app.js")).codexAppPermission(...args)
  },
  cancel: async (id) => (await import("../../codex-app.js")).codexAppCancel(id),
  close: (id) => {
    void import("../../codex-app.js").then((module) => module.codexAppClose(id))
  },
  steering: "step",
  modes: codexAccessModes(),
  defaultMode: CODEX_DEFAULT_MODE,
  setMode: async (...args) => {
    ;(await import("../../codex-app.js")).codexAppSetMode(...args)
  },
}
