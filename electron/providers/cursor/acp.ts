import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { cursorResumePolicy } from "./resume.js"

export const cursorAcpSource: ProviderAcpSource = {
  ...cursorResumePolicy(),
  provider: "cursor",
  clientCapabilities: { _meta: { parameterizedModelPicker: true } },
  // Verified 2026-09-12 (cursor-agent 2026.09.10): `session/load` reopens an
  // acp-sessions store in place, replays its history, and keeps its context.
  // Without this the desk fell back to `cursor-agent -p --resume`, which
  // forked the session into a second store and took the model as a flat id.
  canResume: true,
  // Verified 2026-09-11: a second session/prompt makes cursor-agent cancel the
  // running step (stopReason "cancelled") and continue with the new message.
  steering: "interrupting-prompt",
  // cursor-agent advertises agent/plan/ask and asks for every command and
  // edit in agent mode; its --force/--yolo flags are ignored under `acp`.
  access: {
    native: { ask: "agent", plan: "plan", chat: "ask" },
    host: ["edits", "full"],
    base: "agent",
  },
  nativeModes: [
    { id: "agent", name: "Agent", description: "Full agent capabilities with tool access" },
    { id: "plan", name: "Plan", description: "Read-only" },
    { id: "ask", name: "Ask", description: "Q&A" },
  ],
  available: () => resolveExecutable("cursor-agent") !== null,
  async launch() {
    return {
      command: "cursor-agent",
      args: ["acp"],
      configureEnvironment: () => {},
    }
  },
}
