/**
 * Process warnings Node drops in the host by their code (`--disable-warning`),
 * each one a check a dependency makes of how Mako calls it, which Mako has
 * proven doesn't hold for that use. Every other warning still prints to the
 * host's output. Both ways the host starts pass them: `hostCommand`, and the
 * `mako-host` program's own first line (`scripts/test-host-node.ts` holds the
 * two equal).
 */
export const DISABLED_HOST_WARNINGS = [
  {
    code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED",
    why: "The Agent SDK warns that canUseTool won't be invoked whenever a query starts in bypassPermissions, from the launch options alone. Claude Code still asks it for AskUserQuestion, and for ExitPlanMode once the session is in Plan, and a session's mode can change after launch: Mako's questions and plan approvals reach the person in full access (scripts/test-full-access-questions-live.ts).",
  },
] as const

/** Node's options for the host process, before its program. */
export const HOST_NODE_OPTIONS: readonly string[] = DISABLED_HOST_WARNINGS.map(({ code }) => `--disable-warning=${code}`)
