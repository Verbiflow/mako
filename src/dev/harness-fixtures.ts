import type { HarnessDescriptor } from "@/lib/types"

/** Explicit native fixture inventory; conformance compares this with the host. */
const fixtures = [
  { provider: "claude", displayName: "Claude Code", presentation: { firstRunPriority: 0, icon: { id: "claude-code", tint: "#D97757" } } },
  { provider: "codex", displayName: "Codex", presentation: { firstRunPriority: 1, icon: { id: "codex-cloud", tint: "currentColor" } } },
  { provider: "cursor", displayName: "Cursor", presentation: { firstRunPriority: 2, icon: { id: "cursor-cube", tint: "currentColor" } } },
  { provider: "opencode", displayName: "OpenCode", presentation: { firstRunPriority: 3, icon: { id: "opencode-mark", tint: "currentColor" } } },
  { provider: "grok", displayName: "Grok", presentation: { firstRunPriority: 4, icon: { id: "grok-ring", tint: "currentColor" } } },
  { provider: "devin", displayName: "Devin", presentation: { firstRunPriority: 5, icon: { id: "devin-mark", tint: "#4E8DF6" } } },
] satisfies Omit<HarnessDescriptor, "resumable" | "live" | "canResume">[]

export const fixtureHarnesses: HarnessDescriptor[] = fixtures.map((entry) => ({ ...entry, resumable: entry.provider !== "opencode", live: true, canResume: true }))
