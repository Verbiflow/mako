/** Renderer asset identifiers, independent of harness and model-provider IDs. */
export type HarnessIconId =
  | "claude-code"
  | "codex-cloud"
  | "cursor-cube"
  | "grok-ring"
  | "devin-mark"
  | "opencode-mark"

export interface HarnessPresentation {
  icon: { id: HarnessIconId; tint: string }
}
